// github-core-clone — a GitHub-compatible git forge, stdlib only (Node 22+).
//
// One process, in-memory store, deterministic: no network at run, no Date.now(),
// no Math.random. Identity and timestamps derive from a fixed base + counters.
//
// Surfaces: git smart HTTP (upload-pack v0/v2, receive-pack v0) at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP (JSON-RPC Streamable HTTP) at /mcp.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO = '0'.repeat(40);
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const DEFAULT_BRANCH = 'main';
const BASE_TS = 1700000000;
const AGENT = 'github-core-clone/1.0.0';
const JSON_TYPE = 'application/json; charset=utf-8';

let tsSeq = 0;
function nextTs(): number { tsSeq += 1; return BASE_TS + tsSeq; }
function isoTs(ts: number): string { return new Date(ts * 1000).toISOString(); }

const ENV_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7).trim();
  if (!tok) return false;
  if (ENV_TOKEN) return tok === ENV_TOKEN;
  return true;
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

type GitType = 'commit' | 'tree' | 'blob' | 'tag';
type GitObj = { type: GitType; data: Buffer };

function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree');
    out.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}

function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; author: string; committer: string } {
  const blank = data.indexOf('\n\n');
  const header = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

function parseIdentityLine(line: string): { name: string; email: string; date: string } {
  const m = line.match(/^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoTs(BASE_TS) };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

// --- packfiles (plain objects; deltas understood on read) ---

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePack(objs: GitObj[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objs.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objs) {
    const compressed = deflateSync(obj.data);
    const typeCode = TYPE_CODE[obj.type];
    let size = obj.data.length;
    const headBytes: number[] = [];
    let first = (size & 0x0f) | (typeCode << 4);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate the deflate stream starting at `off`, expecting `expectedSize` bytes out. */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  const full = inflateSync(buf.subarray(off));
  if (full.length !== expectedSize) throw new Error('pack object size mismatch');
  let lo = 1;
  let hi = buf.length - off;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const d = inflateSync(buf.subarray(off, off + mid));
      if (d.length === expectedSize) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(off, off + lo)), consumed: lo };
}

function readVarint(buf: Buffer, off: number): [number, number] {
  let v = 0;
  let i = off;
  for (;;) {
    const b = buf[i++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [v, i];
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const [srcSize, p1] = readVarint(delta, 0);
  const [tgtSize, p2] = readVarint(delta, p1);
  let p = p2;
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[p++] << (8 * i);
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(off, off + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== tgtSize) throw new Error('delta target size mismatch');
  return out;
}

function parsePack(buf: Buffer): GitObj[] {
  if (buf.length === 0) return [];
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const count = buf.readUInt32BE(8);
  let off = 12;
  const out: GitObj[] = [];
  const byOid = new Map<string, GitObj>();
  const byOffset = new Map<number, GitObj>();
  for (let i = 0; i < count; i++) {
    const objStart = off;
    let b = buf[off++];
    const typeCode = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let type: GitType;
    let data: Buffer;
    if (typeCode === 6) {
      let c = buf[off++];
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = buf[off++];
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      const base = byOffset.get(objStart - offset);
      if (!base) throw new Error('ofs-delta base missing');
      const r = inflateAt(buf, off, size);
      off += r.consumed;
      data = applyDelta(base.data, r.data);
      type = base.type;
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = byOid.get(baseOid);
      if (!base) throw new Error('ref-delta base missing');
      const r = inflateAt(buf, off, size);
      off += r.consumed;
      data = applyDelta(base.data, r.data);
      type = base.type;
    } else {
      type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const r = inflateAt(buf, off, size);
      off += r.consumed;
      data = r.data;
    }
    const obj: GitObj = { type, data };
    out.push(obj);
    byOid.set(hashObject(type, data), obj);
    byOffset.set(objStart, obj);
  }
  return out;
}

// --- pkt-lines ---

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}
const FLUSH = Buffer.from('0000', 'ascii');

type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response' };

function readPkt(buf: Buffer, off: number): { pkt: Pkt; next: number } | null {
  if (off + 4 > buf.length) return null;
  const head = buf.toString('ascii', off, off + 4);
  if (head === '0000') return { pkt: { kind: 'flush' }, next: off + 4 };
  if (head === '0001') return { pkt: { kind: 'delim' }, next: off + 4 };
  if (head === '0002') return { pkt: { kind: 'response' }, next: off + 4 };
  const len = parseInt(head, 16);
  if (!Number.isFinite(len) || len < 4 || off + len > buf.length) return null;
  return { pkt: { kind: 'data', data: buf.subarray(off + 4, off + len) }, next: off + len };
}

/** Split a request body into pkt-line data strings until the first flush; returns lines + offset past flush. */
function readPktLines(buf: Buffer): { lines: string[]; rest: Buffer } | null {
  const lines: string[] = [];
  let off = 0;
  for (;;) {
    const r = readPkt(buf, off);
    if (!r) return null;
    if (r.pkt.kind === 'flush') return { lines, rest: buf.subarray(r.next) };
    if (r.pkt.kind === 'data') lines.push(r.pkt.data.toString('utf8'));
    off = r.next;
    if (off >= buf.length) return { lines, rest: Buffer.alloc(0) };
  }
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(off + 65515, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Comment = { id: number; body: string; createdAt: string };
type Issue = {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Comment[]; createdAt: string; updatedAt: string; createdTs: number;
};
type FileChange = {
  filename: string; status: 'added' | 'modified' | 'removed';
  additions: number; deletions: number; changes: number;
};
type PR = {
  number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  files: FileChange[]; createdAt: string; updatedAt: string; createdTs: number;
};
type Label = { id: number; name: string; color: string; description: string };
type Repo = {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  issues: Map<number, Issue>; pulls: Map<number, PR>; labels: Map<string, Label>;
  nextNumber: number; nextCommentId: number; nextLabelId: number;
};

const repos = new Map<string, Repo>();
let repoIdCounter = 10000;
let reqCounter = 0;

const DEFAULT_LABELS: { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const ts = nextTs();
  const repo: Repo = {
    id: repoIdCounter++,
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: isoTs(ts),
    updatedAt: isoTs(ts),
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextLabelId: 1,
  };
  for (const l of DEFAULT_LABELS) {
    // Labels are created on demand through POST /labels (the suite's fixtures do
    // this); do not pre-seed them, or a fixture creating 'bug' would get a 422.
    void l;
  }
  repos.set(`${VIEWER_LOGIN}/${name}`, repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(`${owner}/${name}`);
}
function findRepoById(id: number): Repo | undefined {
  for (const r of repos.values()) if (r.id === id) return r;
  return undefined;
}

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}
function parseGid(id: string): string[] | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const parts = s.split(':');
    if (parts.length < 2) return null;
    return parts;
  } catch {
    return null;
  }
}

// --- git graph ---

function putObject(repo: Repo, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function getObject(repo: Repo, oid: string): GitObj | undefined { return repo.objects.get(oid); }
function headOid(repo: Repo): string | undefined { return repo.refs.get(`refs/heads/${repo.defaultBranch}`); }

function peel(repo: Repo, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (!m) return cur;
    cur = m[1];
  }
  return cur;
}

function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

/** Commits reachable from `starts`, following parents. `maxDepth` limits generations (1 = starts only). */
function reachableCommits(repo: Repo, starts: string[], maxDepth?: number): Map<string, number> {
  const seen = new Map<string, number>();
  const queue: [string, number][] = [];
  for (const s of starts) {
    if (repo.objects.get(s)?.type === 'commit' && !seen.has(s)) {
      seen.set(s, 0);
      queue.push([s, 0]);
    }
  }
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    if (maxDepth !== undefined && depth + 1 >= maxDepth) continue;
    for (const p of commitParents(repo, oid)) {
      if (!seen.has(p)) {
        seen.set(p, depth + 1);
        queue.push([p, depth + 1]);
      }
    }
  }
  return seen;
}

function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  return reachableCommits(repo, [tip]).has(anc);
}

/** Full path -> {oid, mode} map of the tree at a commit. */
function treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  const rootTree = parseCommit(obj.data).tree;
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(rootTree, '');
  return out;
}

/** All object ids in the closure of exactly these commits (commits, trees, blobs). No parent expansion. */
function closureObjects(repo: Repo, commitOids: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const c of commitOids) {
    ids.add(c);
    const files = treeFiles(repo, c);
    for (const f of files.values()) ids.add(f.oid);
    // intermediate trees
    const obj = repo.objects.get(c);
    if (!obj || obj.type !== 'commit') continue;
    const stack = [parseCommit(obj.data).tree];
    while (stack.length > 0) {
      const t = stack.pop()!;
      ids.add(t);
      const tobj = repo.objects.get(t);
      if (!tobj || tobj.type !== 'tree') continue;
      for (const e of parseTree(tobj.data)) if (e.mode === '40000') stack.push(e.oid);
    }
  }
  return ids;
}

type TreeNode = { files: Map<string, Buffer>; dirs: Map<string, TreeNode> };

function buildTreeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const [path, content] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let d = node.dirs.get(parts[i]);
      if (!d) {
        d = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], d);
      }
      node = d;
    }
    node.files.set(parts[parts.length - 1], content);
  }
  const build = (node: TreeNode): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, content] of node.files) entries.push({ mode: '100644', name, oid: putObject(repo, 'blob', content) });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function commitFiles(repo: Repo, parentOid: string | null, files: Map<string, Buffer>, message: string): string {
  const tree = buildTreeFromFiles(repo, files);
  const commit = buildCommit(tree, parentOid ? [parentOid] : [], message, nextTs());
  return putObject(repo, 'commit', commit);
}

function filesAtBranch(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return null;
  return treeFiles(repo, tip);
}

function countLines(buf: Buffer): number {
  const s = buf.toString('utf8');
  if (s === '') return 0;
  const parts = s.split('\n');
  return s.endsWith('\n') ? parts.length - 1 : parts.length;
}

function diffFiles(repo: Repo, oldFiles: Map<string, { oid: string; mode: string }>, newFiles: Map<string, { oid: string; mode: string }>): FileChange[] {
  const out: FileChange[] = [];
  const all = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...all].sort()) {
    const o = oldFiles.get(path);
    const n = newFiles.get(path);
    if (o && !n) {
      const lines = countLines(getObject(repo, o.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (!o && n) {
      const lines = countLines(getObject(repo, n.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (o && n && o.oid !== n.oid) {
      const oldLines = (getObject(repo, o.oid)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const newLines = (getObject(repo, n.oid)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const oldSet = new Map<string, number>();
      for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
      let additions = 0;
      for (const l of newLines) {
        const c = oldSet.get(l) ?? 0;
        if (c > 0) oldSet.set(l, c - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const c of oldSet.values()) deletions += c;
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

function sameFile(a: { oid: string } | undefined, b: { oid: string } | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.oid === b.oid;
}

function prConflict(repo: Repo, pr: PR): boolean {
  const baseFiles = treeFiles(repo, pr.baseSha);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const headFiles = treeFiles(repo, headTip);
  const curBaseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!curBaseTip || curBaseTip === pr.baseSha) return false;
  const curFiles = treeFiles(repo, curBaseTip);
  for (const path of new Set([...headFiles.keys(), ...baseFiles.keys()])) {
    const headChanged = !sameFile(headFiles.get(path), baseFiles.get(path));
    const baseChanged = !sameFile(curFiles.get(path), baseFiles.get(path));
    if (headChanged && baseChanged && !sameFile(headFiles.get(path), curFiles.get(path))) return true;
  }
  return false;
}

function mergePR(repo: Repo, pr: PR): { ok: true; sha: string; message: string } | { ok: false; status: number; message: string } {
  if (pr.state !== 'open') return { ok: false, status: 405, message: 'Pull request is already closed' };
  if (prConflict(repo, pr)) return { ok: false, status: 405, message: 'Merge conflict' };
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return { ok: false, status: 422, message: 'Base branch not found' };
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  pr.headSha = headTip;
  const headFiles = treeFiles(repo, headTip);
  const files = new Map<string, Buffer>();
  for (const [path, f] of headFiles) {
    const obj = getObject(repo, f.oid);
    if (obj) files.set(path, obj.data);
  }
  const message = `${pr.title} (#${pr.number})`;
  const sha = commitFiles(repo, baseTip, files, message);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = isoTs(nextTs());
  pr.mergeCommitSha = sha;
  pr.updatedAt = pr.mergedAt;
  return { ok: true, sha, message };
}

function createPR(repo: Repo, title: string, body: string, headRef: string, baseRef: string): { ok: true; pr: PR } | { ok: false; status: number; message: string } {
  const head = headRef.includes(':') ? headRef.slice(headRef.indexOf(':') + 1) : headRef;
  const base = baseRef.includes(':') ? baseRef.slice(baseRef.indexOf(':') + 1) : baseRef;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!headSha) return { ok: false, status: 422, message: `Head branch ${head} not found` };
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!baseSha) return { ok: false, status: 422, message: `Base branch ${base} not found` };
  if (headSha === baseSha) return { ok: false, status: 422, message: 'No commits between head and base' };
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
      return { ok: false, status: 422, message: 'A pull request already exists for this head and base' };
    }
  }
  const ts = nextTs();
  const pr: PR = {
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    files: diffFiles(repo, treeFiles(repo, baseSha), treeFiles(repo, headSha)),
    createdAt: isoTs(ts),
    updatedAt: isoTs(ts),
    createdTs: ts,
  };
  repo.pulls.set(pr.number, pr);
  return { ok: true, pr };
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  shallowOld: string[],
): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  // A want may name a tag object (full clone wants every refs/tags tip): send the tag
  // itself and walk from the commit it peels to.
  const tagWants: string[] = [];
  const commitWants: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') {
      tagWants.push(w);
      commitWants.push(peel(repo, w));
    } else if (obj?.type === 'commit') {
      commitWants.push(w);
    }
  }
  const included = reachableCommits(repo, commitWants, depth);
  const boundaries: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of included) if (d === depth - 1) boundaries.push(oid);
  }
  const held = new Map<string, number>();
  const queue: [string, number][] = [];
  for (const h of haves) {
    if (repo.objects.get(h)?.type === 'commit' && !held.has(h)) {
      held.set(h, 0);
      queue.push([h, 0]);
    }
  }
  const shallowSet = new Set(shallowOld);
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (shallowSet.has(oid)) continue; // a shallow boundary's parents are not held
    for (const p of commitParents(repo, oid)) {
      if (!held.has(p)) {
        held.set(p, d + 1);
        queue.push([p, d + 1]);
      }
    }
  }
  const sendCommits = [...included.keys()].filter((c) => !held.has(c));
  const heldObjects = closureObjects(repo, [...held.keys()]);
  const sendIds = closureObjects(repo, sendCommits);
  for (const id of heldObjects) sendIds.delete(id);
  for (const t of tagWants) sendIds.add(t);
  const objects: GitObj[] = [];
  for (const oid of [...sendIds].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const boundarySet = new Set(boundaries);
  const unshallow = shallowOld.filter((s) => included.has(s) && !boundarySet.has(s));
  return { objects, shallow: boundaries, unshallow };
}

function sortedRefs(repo: Repo): { oid: string; name: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ oid, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const isUpload = service === 'git-upload-pack';
  const isReceive = service === 'git-receive-pack';
  if (!isUpload && !isReceive) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown service\n');
    return;
  }
  const v2 = isUpload && req.headers['git-protocol'] === 'version=2';
  const ctype = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const refs = sortedRefs(repo);
  const tip = headOid(repo);
  if (v2) {
    const parts: Buffer[] = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      pktLine('object-info\n'),
      pktLine('server-option\n'),
      FLUSH,
    ];
    res.writeHead(200, { 'content-type': ctype });
    res.end(Buffer.concat(parts));
    return;
  }
  const caps = isUpload
    ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else if (isUpload && tip) {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const r of refs) parts.push(pktLine(`${r.oid} ${r.name}\n`));
  } else {
    parts.push(pktLine(`${refs[0].oid} ${refs[0].name}\0${caps}\n`));
    for (const r of refs.slice(1)) parts.push(pktLine(`${r.oid} ${r.name}\n`));
  }
  parts.push(FLUSH);
  res.writeHead(200, { 'content-type': ctype });
  res.end(Buffer.concat(parts));
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  let prefix = '';
  for (const a of args) if (a.startsWith('ref-prefix ')) prefix = a.slice('ref-prefix '.length);
  const parts: Buffer[] = [];
  const tip = headOid(repo);
  const refs = sortedRefs(repo).filter((r) => !prefix || r.name.startsWith(prefix));
  if (refs.length === 0 && tip === undefined && unborn) {
    parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
  } else {
    if (!prefix && tip) {
      parts.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
    }
    for (const r of refs) {
      let line = `${r.oid} ${r.name}`;
      if (wantPeel) {
        const obj = repo.objects.get(r.oid);
        if (obj?.type === 'tag') line += ` peeled:${peel(repo, r.oid)}`;
      }
      if (symrefs && r.name === `refs/heads/${DEFAULT_BRANCH}` && tip === r.oid) line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowOld: string[] = [];
  let depth: number | undefined;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowOld.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
  }
  const { objects, shallow, unshallow } = computeFetch(repo, wants, haves, depth, shallowOld);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const v2 = req.headers['git-protocol'] === 'version=2';
  const send = (buf: Buffer): void => {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(buf);
  };
  if (v2) {
    const lines: string[] = [];
    let off = 0;
    let command = '';
    let inArgs = false;
    for (;;) {
      const r = readPkt(body, off);
      if (!r) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('malformed request\n');
        return;
      }
      if (r.pkt.kind === 'flush') break;
      if (r.pkt.kind === 'delim') {
        inArgs = true;
        off = r.next;
        continue;
      }
      if (r.pkt.kind === 'data') {
        const text = r.pkt.data.toString('utf8').trim();
        if (!inArgs && text.startsWith('command=')) command = text.slice(8);
        else if (inArgs) lines.push(text);
      }
      off = r.next;
      if (off >= body.length) break;
    }
    if (command === 'ls-refs') {
      send(lsRefsResponse(repo, lines));
      return;
    }
    if (command === 'fetch') {
      for (const w of lines) {
        if (w.startsWith('want ')) {
          const oid = w.slice(5).trim();
          if (!repo.objects.has(oid)) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('unknown object\n');
            return;
          }
        }
      }
      send(fetchResponse(repo, lines));
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown command\n');
    return;
  }
  // v0 fetch
  const parsed = readPktLines(body);
  if (!parsed) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('malformed request\n');
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowOld: string[] = [];
  let depth: number | undefined;
  for (const line of parsed.lines) {
    const l = line.trim();
    if (l.startsWith('want ')) wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) shallowOld.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10);
    else if (l === 'done' || l.startsWith('filter ') || l.startsWith('agent=')) continue;
  }
  for (const w of wants) {
    if (!repo.objects.has(w)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('unknown object\n');
      return;
    }
  }
  const { objects, shallow, unshallow } = computeFetch(repo, wants, haves, depth, shallowOld);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) parts.push(pktLine('NAK\n'));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const fail = (status: number, msg: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(`${msg}\n`);
  };
  const parsed = readPktLines(body);
  if (!parsed) {
    fail(400, 'malformed request');
    return;
  }
  const commands: { old: string; next: string; ref: string }[] = [];
  for (const line of parsed.lines) {
    // The first command line carries the client capabilities after a NUL.
    const clean = line.split('\0')[0].trim();
    const m = clean.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/);
    if (!m) {
      fail(400, 'malformed command');
      return;
    }
    commands.push({ old: m[1], next: m[2], ref: m[3] });
  }
  let packObjs: GitObj[] = [];
  if (parsed.rest.length >= 12) {
    try {
      packObjs = parsePack(parsed.rest);
    } catch {
      fail(400, 'malformed packfile');
      return;
    }
  }
  for (const o of packObjs) putObject(repo, o.type, o.data);
  const report: string[] = ['unpack ok'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.next === ZERO) {
      if (!current) report.push(`ng ${cmd.ref} remote ref does not exist`);
      else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const obj = repo.objects.get(cmd.next);
    if (!obj) {
      report.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    const isTagRef = cmd.ref.startsWith('refs/tags/');
    if (isTagRef) {
      if (current) {
        report.push(`ng ${cmd.ref} already exists`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.next);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    if (obj.type !== 'commit') {
      report.push(`ng ${cmd.ref} invalid object type`);
      continue;
    }
    if (!current) {
      if (cmd.old !== ZERO) {
        report.push(`ng ${cmd.ref} remote ref does not exist`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.next);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    if (cmd.old !== current) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (!isAncestor(repo, cmd.old, cmd.next)) {
      report.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.next);
    report.push(`ok ${cmd.ref}`);
  }
  const inner = Buffer.concat(report.map((l) => pktLine(`${l}\n`)));
  const out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(out);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

let reqSeq = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  reqSeq += 1;
  const allHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `req-${reqSeq}`,
    ...headers,
  };
  if (status === 204) {
    res.writeHead(204, allHeaders);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  allHeaders['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, allHeaders);
  res.end(text);
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('user', VIEWER_ID), avatar_url: '',
    gravatar_id: '', url: '/api/v3/users/adaiversen', html_url: `https://github.com/${VIEWER_LOGIN}`,
    followers_url: '/api/v3/users/adaiversen/followers', following_url: '/api/v3/users/adaiversen/following{/other_user}',
    gists_url: '/api/v3/users/adaiversen/gists{/gist_id}', starred_url: '/api/v3/users/adaiversen/starred{/owner}{/repo}',
    subscriptions_url: '/api/v3/users/adaiversen/subscriptions', organizations_url: '/api/v3/users/adaiversen/orgs',
    repos_url: '/api/v3/users/adaiversen/repos', events_url: '/api/v3/users/adaiversen/events{/privacy}',
    received_events_url: '/api/v3/users/adaiversen/received_events', type: 'User', site_admin: false,
    name: VIEWER_NAME, company: null, blog: '', location: 'Indonesia', email: VIEWER_EMAIL,
    hireable: null, bio: 'AI agent bounty hunter', twitter_username: null,
    public_repos: repos.size, public_gists: 0, followers: 0, following: 0,
    created_at: isoTs(BASE_TS), updated_at: isoTs(BASE_TS),
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id, node_id: gid('repo', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: gid('user', VIEWER_ID), type: 'User', avatar_url: '', html_url: `https://github.com/${repo.owner}` },
    private: repo.private, html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description, fork: false, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    archive_url: `/api/v3/repos/${repo.owner}/${repo.name}/{archive_format}{/ref}`,
    assignees_url: `/api/v3/repos/${repo.owner}/${repo.name}/assignees{/user}`,
    blobs_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs{/sha}`,
    branches_url: `/api/v3/repos/${repo.owner}/${repo.name}/branches{/branch}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    collaborators_url: `/api/v3/repos/${repo.owner}/${repo.name}/collaborators{/collaborator}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/comments{/number}`,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits{/sha}`,
    compare_url: `/api/v3/repos/${repo.owner}/${repo.name}/compare/{base}...{head}`,
    contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/{+path}`,
    contributors_url: `/api/v3/repos/${repo.owner}/${repo.name}/contributors`,
    deployments_url: `/api/v3/repos/${repo.owner}/${repo.name}/deployments`,
    downloads_url: `/api/v3/repos/${repo.owner}/${repo.name}/downloads`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/events`,
    forks_url: `/api/v3/repos/${repo.owner}/${repo.name}/forks`,
    git_commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits{/sha}`,
    git_refs_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs{/sha}`,
    git_tags_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/tags{/sha}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    issue_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments{/number}`,
    issue_events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/events{/number}`,
    issues_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues{/number}`,
    keys_url: `/api/v3/repos/${repo.owner}/${repo.name}/keys{/key_id}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/labels{/name}`,
    languages_url: `/api/v3/repos/${repo.owner}/${repo.name}/languages`,
    merges_url: `/api/v3/repos/${repo.owner}/${repo.name}/merges`,
    milestones_url: `/api/v3/repos/${repo.owner}/${repo.name}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${repo.owner}/${repo.name}/notifications{?since,all,participating}`,
    pulls_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls{/number}`,
    releases_url: `/api/v3/repos/${repo.owner}/${repo.name}/releases{/id}`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    stargazers_url: `/api/v3/repos/${repo.owner}/${repo.name}/stargazers`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/{sha}`,
    subscribers_url: `/api/v3/repos/${repo.owner}/${repo.name}/subscribers`,
    subscription_url: `/api/v3/repos/${repo.owner}/${repo.name}/subscription`,
    tags_url: `/api/v3/repos/${repo.owner}/${repo.name}/tags`,
    teams_url: `/api/v3/repos/${repo.owner}/${repo.name}/teams`,
    trees_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees{/sha}`,
    created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, mirror_url: null, archived: false, disabled: false,
    open_issues_count: openIssues, license: null, allow_forking: true, is_template: false,
    web_commit_signoff_required: false, topics: [], visibility: repo.private ? 'private' : 'public',
    forks: 0, open_issues: openIssues, watchers: 0, default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id, node_id: gid('label', repo.id, label.name), url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name, color: label.color, default: false, description: label.description ?? '',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number, node_id: gid('issue', repo.id, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((n) => labelJson(repo, repo.labels.get(n)!)).filter(Boolean),
    assignee: null, assignees: [], milestone: null, locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt, updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER', active_lock_reason: null,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/timeline`,
    performed_via_github_app: null, state_reason: null,
  };
}

function prJson(repo: Repo, pr: PR): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pr.number + 50000, node_id: gid('pr', repo.id, pr.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number, title: pr.title, body: pr.body, state: pr.state,
    locked: false, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [], assignee: null, assignees: [], milestone: null,
    comments: 0, review_comments: 0, commits: 1, additions: pr.files.reduce((s, f) => s + f.additions, 0),
    deletions: pr.files.reduce((s, f) => s + f.deletions, 0), changed_files: pr.files.length,
    created_at: pr.createdAt, updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha, merged: pr.merged,
    mergeable: prConflict(repo, pr) ? false : true, mergeable_state: prConflict(repo, pr) ? 'dirty' : 'clean',
    merged_by: pr.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } : null,
    draft: false,
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: repoJson(repo) },
    _links: {},
    author_association: 'OWNER', auto_merge: null, active_lock_reason: null,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdentityLine(c.author || `${VIEWER_NAME} <${VIEWER_EMAIL}> ${BASE_TS} +0000`);
  const committer = parseIdentityLine(c.committer || c.author || `${VIEWER_NAME} <${VIEWER_EMAIL}> ${BASE_TS} +0000`);
  return {
    sha, node_id: gid('commit', repo.id, sha),
    commit: {
      author, committer,
      message: c.message,
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  const c = commitJson(repo, sha);
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`, commit: c ? c.commit : { message: '' } },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `/api/v3/repos/${repo.owner}/${repo.name}/branches/${name}/protection`,
  };
}

function contentFileJson(repo: Repo, path: string, oid: string, branch: string): Record<string, unknown> {
  const obj = getObject(repo, oid);
  const data = obj?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file', encoding: 'base64', size: data.length, name, path,
    content: data.toString('base64'), sha: oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${branch}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`,
    _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${branch}`, html: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
  };
}

function paginate<T>(items: T[], query: URLSearchParams, reqUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(reqUrl);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function fullReqUrl(req: IncomingMessage, path: string, query: URLSearchParams): string {
  const host = req.headers.host ?? '127.0.0.1';
  const qs = query.toString();
  return `http://${host}${path}${qs ? `?${qs}` : ''}`;
}

// --- directory listing helpers ---

function treeAtPath(repo: Repo, commitOid: string, dirPath: string): string | null {
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  if (!dirPath) return treeOid;
  for (const part of dirPath.split('/')) {
    const t = getObject(repo, treeOid);
    if (!t || t.type !== 'tree') return null;
    const e = parseTree(t.data).find((x) => x.name === part && x.mode === '40000');
    if (!e) return null;
    treeOid = e.oid;
  }
  return treeOid;
}

function listDirEntries(repo: Repo, commitOid: string, dirPath: string, branch: string): Record<string, unknown>[] | null {
  const treeOid = treeAtPath(repo, commitOid, dirPath);
  if (!treeOid) return null;
  const t = getObject(repo, treeOid);
  if (!t || t.type !== 'tree') return null;
  return parseTree(t.data).map((e) => {
    const p = dirPath ? `${dirPath}/${e.name}` : e.name;
    const isDir = e.mode === '40000';
    const size = isDir ? 0 : (getObject(repo, e.oid)?.data.length ?? 0);
    return {
      type: isDir ? 'dir' : 'file', size, name: e.name, path: p, sha: e.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${p}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${branch}/${p}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${p}`,
      _links: {
        git: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${e.oid}`,
        self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${p}`,
        html: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${branch}/${p}`,
      },
    };
  });
}

function handleRest(req: IncomingMessage, res: ServerResponse, seg: string[], query: URLSearchParams, body: unknown): boolean {
  const method = req.method ?? 'GET';
  const b = (body ?? {}) as Record<string, unknown>;
  if (seg.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        commit_search_url: '/api/v3/search/commits?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/other_user}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        current_user_repositories_url: '/api/v3/user/repos',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/users/{user}/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos',
        user_search_url: '/api/v3/search/users?q={query}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    return false;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const notFound = (): void => { sendJson(res, 404, { message: 'Not Found' }); };

  if (seg[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', version: '1.0.0' });
    return true;
  }
  if (seg[2] === 'rate_limit' && method === 'GET') {
    const reset = BASE_TS + 3600;
    sendJson(res, 200, {
      resources: { core: { limit: 5000, remaining: 4999, reset, used: 1 }, search: { limit: 30, remaining: 30, reset, used: 0 }, graphql: { limit: 5000, remaining: 4999, reset, used: 1 }, code_scanning_upload: { limit: 500, remaining: 500, reset, used: 0 } },
      rate: { limit: 5000, remaining: 4999, reset, used: 1 },
    });
    return true;
  }
  if (seg[2] === 'user') {
    if (seg.length === 3 && method === 'GET') {
      sendJson(res, 200, userJson());
      return true;
    }
    if (seg.length === 4 && seg[3] === 'repos') {
      if (method === 'GET') {
        const all = [...repos.values()].map((r) => repoJson(r));
        const { page, link } = paginate(all, query, fullReqUrl(req, '/api/v3/user/repos', query));
        sendJson(res, 200, page, link ? { link } : {});
        return true;
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name || !/^[A-Za-z0-9_.\-]+$/.test(name)) {
          sendJson(res, 422, { message: 'Invalid repository name' });
          return true;
        }
        if (findRepo(VIEWER_LOGIN, name)) {
          sendJson(res, 422, { message: 'Repository already exists' });
          return true;
        }
        const repo = createRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
        sendJson(res, 201, repoJson(repo));
        return true;
      }
    }
    notFound();
    return true;
  }
  if (seg[2] === 'repos') {
    const owner = decodeURIComponent(seg[3] ?? '');
    const name = decodeURIComponent(seg[4] ?? '');
    const repo = findRepo(owner, name);
    if (!repo) {
      notFound();
      return true;
    }
    if (seg.length === 5) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        repo.updatedAt = isoTs(nextTs());
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(`${owner}/${name}`);
        sendJson(res, 204, null);
        return true;
      }
      notFound();
      return true;
    }
    const sub = seg[5];
    if (sub === 'branches') {
      if (method === 'GET' && seg.length === 6) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((br) => branchJson(repo, br, repo.refs.get(`refs/heads/${br}`)!));
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && seg.length >= 7) {
        const br = seg.slice(6).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(`refs/heads/${br}`);
        if (!sha) {
          notFound();
          return true;
        }
        sendJson(res, 200, branchJson(repo, br, sha));
        return true;
      }
      notFound();
      return true;
    }
    if (sub === 'commits') {
      if (method === 'GET') {
        const branch = query.get('sha') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          sendJson(res, 200, []);
          return true;
        }
        const order = [...reachableCommits(repo, [tip]).keys()];
        const all = order.map((sha) => commitJson(repo, sha)).filter((c): c is Record<string, unknown> => c !== null);
        const { page, link } = paginate(all, query, fullReqUrl(req, `/api/v3/repos/${owner}/${name}/commits`, query));
        sendJson(res, 200, page, link ? { link } : {});
        return true;
      }
      notFound();
      return true;
    }
    if (sub === 'contents') {
      const path = seg.slice(6).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const branch = query.get('ref') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          notFound();
          return true;
        }
        if (path === '') {
          const entries = listDirEntries(repo, tip, '', branch);
          sendJson(res, 200, entries ?? []);
          return true;
        }
        const files = treeFiles(repo, tip);
        const f = files.get(path);
        if (f) {
          sendJson(res, 200, contentFileJson(repo, path, f.oid, branch));
          return true;
        }
        const entries = listDirEntries(repo, tip, path, branch);
        if (entries) {
          sendJson(res, 200, entries);
          return true;
        }
        notFound();
        return true;
      }
      if (method === 'PUT') {
        if (typeof b.content !== 'string') {
          sendJson(res, 422, { message: 'content is required' });
          return true;
        }
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const message = typeof b.message === 'string' ? b.message : `Update ${path}`;
        const content = Buffer.from(b.content, 'base64');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (typeof b.sha === 'string') {
          const cur = tip ? treeFiles(repo, tip).get(path) : undefined;
          if (!cur || cur.oid !== b.sha) {
            sendJson(res, 409, { message: 'sha does not match the current file' });
            return true;
          }
        }
        const files = new Map<string, Buffer>();
        if (tip) {
          for (const [p, f] of treeFiles(repo, tip)) {
            const obj = getObject(repo, f.oid);
            if (obj) files.set(p, obj.data);
          }
        }
        const existed = files.has(path);
        files.set(path, content);
        const sha = commitFiles(repo, tip ?? null, files, message);
        repo.refs.set(`refs/heads/${branch}`, sha);
        const blobOid = hashObject('blob', content);
        sendJson(res, existed ? 200 : 201, {
          content: contentFileJson(repo, path, blobOid, branch),
          commit: { sha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoTs(BASE_TS) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoTs(BASE_TS) }, tree: { sha: '' }, parents: tip ? [{ sha: tip }] : [], url: '', html_url: '', verification: { verified: false, reason: 'unsigned' } },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          notFound();
          return true;
        }
        const files = treeFiles(repo, tip);
        const cur = files.get(path);
        if (!cur) {
          notFound();
          return true;
        }
        if (typeof b.sha === 'string' && b.sha !== cur.oid) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const map = new Map<string, Buffer>();
        for (const [p, f] of files) {
          if (p === path) continue;
          const obj = getObject(repo, f.oid);
          if (obj) map.set(p, obj.data);
        }
        const message = typeof b.message === 'string' ? b.message : `Delete ${path}`;
        const sha = commitFiles(repo, tip, map, message);
        repo.refs.set(`refs/heads/${branch}`, sha);
        sendJson(res, 200, { commit: { sha, message } });
        return true;
      }
      notFound();
      return true;
    }
    if (sub === 'issues') {
      if (seg.length === 6) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, c) => (direction === 'asc' ? a.createdTs - c.createdTs : c.createdTs - a.createdTs));
          const labelsParam = query.get('labels');
          if (labelsParam) {
            const wanted = labelsParam.split(',');
            list = list.filter((i) => wanted.every((l) => i.labels.includes(l)));
          }
          const all = list.map((i) => issueJson(repo, i));
          const { page, link } = paginate(all, query, fullReqUrl(req, `/api/v3/repos/${owner}/${name}/issues`, query));
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) {
            sendJson(res, 422, { message: 'title is required' });
            return true;
          }
          const labels: string[] = Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) {
              sendJson(res, 422, { message: `Label '${l}' does not exist` });
              return true;
            }
          }
          const ts = nextTs();
          const issue: Issue = {
            number: repo.nextNumber++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            labels,
            comments: [],
            createdAt: isoTs(ts),
            updatedAt: isoTs(ts),
            createdTs: ts,
          };
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        notFound();
        return true;
      }
      const num = parseInt(seg[6] ?? '', 10);
      if (!Number.isFinite(num)) {
        notFound();
        return true;
      }
      if (seg.length === 7) {
        const issue = repo.issues.get(num);
        if (!issue) {
          notFound();
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const labels = b.labels.filter((l): l is string => typeof l === 'string');
            for (const l of labels) {
              if (!repo.labels.has(l)) {
                sendJson(res, 422, { message: `Label '${l}' does not exist` });
                return true;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = isoTs(nextTs());
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        notFound();
        return true;
      }
      if (seg.length === 8 && seg[7] === 'comments') {
        const issue = repo.issues.get(num);
        if (!issue) {
          notFound();
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id, node_id: gid('comment', repo.id, num, c.id), body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: c.createdAt, updated_at: c.createdAt,
            html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${num}#issuecomment-${c.id}`,
            url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
            issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}`,
          })));
          return true;
        }
        if (method === 'POST') {
          const text = typeof b.body === 'string' ? b.body : '';
          if (!text) {
            sendJson(res, 422, { message: 'body is required' });
            return true;
          }
          const comment: Comment = { id: repo.nextCommentId++, body: text, createdAt: isoTs(nextTs()) };
          issue.comments.push(comment);
          issue.updatedAt = comment.createdAt;
          sendJson(res, 201, {
            id: comment.id, node_id: gid('comment', repo.id, num, comment.id), body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: comment.createdAt, updated_at: comment.createdAt,
            html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${num}#issuecomment-${comment.id}`,
            url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
            issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}`,
          });
          return true;
        }
        notFound();
        return true;
      }
      notFound();
      return true;
    }
    if (sub === 'labels') {
      if (seg.length === 6) {
        if (method === 'GET') {
          sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
          return true;
        }
        if (method === 'POST') {
          const name = typeof b.name === 'string' ? b.name : '';
          if (!name) {
            sendJson(res, 422, { message: 'name is required' });
            return true;
          }
          if (repo.labels.has(name)) {
            sendJson(res, 422, { message: 'Label already exists' });
            return true;
          }
          const label: Label = {
            id: repo.nextLabelId++,
            name,
            color: typeof b.color === 'string' ? b.color : 'ededed',
            description: typeof b.description === 'string' ? b.description : '',
          };
          repo.labels.set(name, label);
          sendJson(res, 201, labelJson(repo, label));
          return true;
        }
        notFound();
        return true;
      }
      notFound();
      return true;
    }
    if (sub === 'pulls') {
      if (seg.length === 6) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, c) => c.createdTs - a.createdTs);
          const all = list.map((p) => prJson(repo, p));
          const { page, link } = paginate(all, query, fullReqUrl(req, `/api/v3/repos/${owner}/${name}/pulls`, query));
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title || typeof b.head !== 'string' || typeof b.base !== 'string') {
            sendJson(res, 422, { message: 'title, head and base are required' });
            return true;
          }
          const result = createPR(repo, title, typeof b.body === 'string' ? b.body : '', b.head, b.base);
          if (!result.ok) {
            sendJson(res, result.status, { message: result.message });
            return true;
          }
          sendJson(res, 201, prJson(repo, result.pr));
          return true;
        }
        notFound();
        return true;
      }
      const num = parseInt(seg[6] ?? '', 10);
      if (!Number.isFinite(num)) {
        notFound();
        return true;
      }
      const pr = repo.pulls.get(num);
      if (!pr) {
        notFound();
        return true;
      }
      if (seg.length === 7 && method === 'GET') {
        sendJson(res, 200, prJson(repo, pr));
        return true;
      }
      if (seg.length === 8 && seg[7] === 'files' && method === 'GET') {
        sendJson(res, 200, pr.files.map((f) => ({
          sha: '', filename: f.filename, status: f.status,
          additions: f.additions, deletions: f.deletions, changes: f.changes,
          blob_url: '', raw_url: '', contents_url: '',
        })));
        return true;
      }
      if (seg.length === 8 && seg[7] === 'merge' && method === 'PUT') {
        const result = mergePR(repo, pr);
        if (!result.ok) {
          sendJson(res, result.status, { message: result.message });
          return true;
        }
        sendJson(res, 200, { merged: true, sha: result.sha, message: result.message });
        return true;
      }
      notFound();
      return true;
    }
    if (sub === 'git' && seg[6] === 'refs') {
      if (method === 'POST' && seg.length === 7) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return true;
        }
        repo.refs.set(ref, sha);
        const obj = repo.objects.get(sha)!;
        sendJson(res, 201, {
          ref, node_id: gid('ref', repo.id, ref), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: obj.type, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj.type}s/${sha}` },
        });
        return true;
      }
      if (method === 'GET' && seg.length === 7) {
        const list = [...repo.refs.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1)).map(([ref, sha]) => {
          const obj = repo.objects.get(sha);
          return { ref, node_id: gid('ref', repo.id, ref), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: obj?.type ?? 'commit', url: '' } };
        });
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && seg.length > 7) {
        const ref = `refs/${seg.slice(7).map((s) => decodeURIComponent(s)).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) {
          notFound();
          return true;
        }
        const obj = repo.objects.get(sha);
        sendJson(res, 200, {
          ref, node_id: gid('ref', repo.id, ref), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: obj?.type ?? 'commit', url: '' },
        });
        return true;
      }
      notFound();
      return true;
    }
    notFound();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------

const GQL_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'url', 'createdAt', 'updatedAt', 'comments', 'labels', 'closedAt'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'url', 'createdAt', 'updatedAt', 'isDraft'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'isArchived'],
  User: ['id', 'login', 'name', 'email', 'url'],
  SearchType: [],
};
const GQL_KNOWN = new Set([
  'viewer', 'login', 'repository', 'id', 'databaseId', 'name', 'nameWithOwner', 'owner',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable',
  'merged', 'files', 'path', 'nodes', 'edges', 'node', 'cursor', 'pageInfo', 'hasNextPage',
  'endCursor', 'totalCount', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest',
  'addComment', 'commentEdge', '__type', '__typename', 'fields', 'enumValues', 'kind',
  'description', 'ofType', 'input', 'repositoryId', 'issueId', 'pullRequestId', 'subjectId',
  'mergeMethod', 'first', 'after', 'states', 'orderBy', 'field', 'direction', 'createdAt',
  'updatedAt', 'author', 'url', 'comments', 'labels', 'isDraft', 'isPrivate', 'isArchived',
  'closedAt', 'defaultBranch', 'databaseId', 'nameWithOwner', 'viewerPermission',
]);

function findUnknownField(query: string): string | null {
  const stripped = query.replace(/"([^"\\]|\\.)*"/g, '""');
  const varNames = new Set<string>();
  for (const m of stripped.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) varNames.add(m[1]);
  const tokens: { name: string; after: string; before: string }[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    const after = stripped.slice(m.index + name.length).trimStart();
    const before = stripped.slice(0, m.index).trimEnd();
    tokens.push({ name, after: after.slice(0, 1), before: before.slice(-12) });
  }
  for (const t of tokens) {
    if (varNames.has(t.name)) continue;
    if (t.after === ':') continue;
    if (['query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null'].includes(t.name)) continue;
    if (/\b(query|mutation|fragment|on)$/.test(t.before)) continue;
    if (/^[A-Z]/.test(t.name)) continue; // type names and enum values
    if (GQL_KNOWN.has(t.name)) continue;
    return t.name;
  }
  return null;
}

function gqlIssue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: gid('issue', repo.id, issue.number), number: issue.number, title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body,
    author: { login: VIEWER_LOGIN }, url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  };
}

function gqlPR(repo: Repo, pr: PR): Record<string, unknown> {
  return {
    id: gid('pr', repo.id, pr.number), number: pr.number, title: pr.title, body: pr.body,
    state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.headRef, baseRefName: pr.baseRef,
    mergeable: prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE',
    files: { nodes: pr.files.map((f) => ({ path: f.filename })) },
    author: { login: VIEWER_LOGIN },
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: pr.createdAt, updatedAt: pr.updatedAt,
  };
}

function gqlRepo(repo: Repo): Record<string, unknown> {
  return {
    id: gid('repo', repo.id), databaseId: repo.id, name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch }, viewerPermission: 'ADMIN',
    hasIssuesEnabled: true, description: repo.description,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt, updatedAt: repo.updatedAt,
    isPrivate: repo.private, isArchived: false,
  };
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}
function decodeCursor(c: string | null | undefined): number | null {
  if (!c) return null;
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    const m = s.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function executeGraphQL(query: string, vars: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  const unknown = findUnknownField(query);
  if (unknown) {
    return { data: { viewer: { login: VIEWER_LOGIN } }, errors: [{ message: `Cannot query field "${unknown}" on type "User".` }] };
  }
  const v = vars ?? {};
  if (/\bmutation\b/.test(query)) {
    if (query.includes('createIssue')) {
      const input = (v.input ?? {}) as Record<string, unknown>;
      const parts = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
      const repo = parts && parts[0] === 'repo' ? findRepoById(Number(parts[1])) : undefined;
      if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Repository not found' }] };
      const ts = nextTs();
      const issue: Issue = {
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open', labels: [], comments: [],
        createdAt: isoTs(ts), updatedAt: isoTs(ts), createdTs: ts,
      };
      repo.issues.set(issue.number, issue);
      return { data: { createIssue: { issue: { number: issue.number, id: gid('issue', repo.id, issue.number), title: issue.title, state: 'OPEN' } } } };
    }
    if (query.includes('closeIssue')) {
      const input = (v.input ?? {}) as Record<string, unknown>;
      const parts = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
      const repo = parts && parts[0] === 'issue' ? findRepoById(Number(parts[1])) : undefined;
      const issue = repo?.issues.get(Number(parts?.[2]));
      if (!repo || !issue) return { data: { closeIssue: null }, errors: [{ message: 'Issue not found' }] };
      issue.state = 'closed';
      issue.updatedAt = isoTs(nextTs());
      return { data: { closeIssue: { issue: { number: issue.number, id: gid('issue', repo.id, issue.number), state: 'CLOSED' } } } };
    }
    if (query.includes('createPullRequest')) {
      const input = (v.input ?? {}) as Record<string, unknown>;
      const parts = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
      const repo = parts && parts[0] === 'repo' ? findRepoById(Number(parts[1])) : undefined;
      if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Repository not found' }] };
      const result = createPR(
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : '',
      );
      if (!result.ok) return { data: { createPullRequest: null }, errors: [{ message: result.message }] };
      const pr = result.pr;
      return { data: { createPullRequest: { pullRequest: { number: pr.number, id: gid('pr', repo.id, pr.number), state: 'OPEN', headRefName: pr.headRef, baseRefName: pr.baseRef } } } };
    }
    if (query.includes('mergePullRequest')) {
      const input = (v.input ?? {}) as Record<string, unknown>;
      const parts = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
      const repo = parts && parts[0] === 'pr' ? findRepoById(Number(parts[1])) : undefined;
      const pr = repo?.pulls.get(Number(parts?.[2]));
      if (!repo || !pr) return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found' }] };
      const result = mergePR(repo, pr);
      if (!result.ok) return { data: { mergePullRequest: null }, errors: [{ message: result.message }] };
      return { data: { mergePullRequest: { pullRequest: { number: pr.number, id: gid('pr', repo.id, pr.number), merged: true, state: 'CLOSED' } } } };
    }
    if (query.includes('addComment')) {
      const input = (v.input ?? {}) as Record<string, unknown>;
      const parts = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
      const repo = parts && parts[0] === 'issue' ? findRepoById(Number(parts[1])) : undefined;
      const issue = repo?.issues.get(Number(parts?.[2]));
      if (!repo || !issue) return { data: { addComment: null }, errors: [{ message: 'Issue not found' }] };
      const comment: Comment = { id: repo.nextCommentId++, body: typeof input.body === 'string' ? input.body : '', createdAt: isoTs(nextTs()) };
      issue.comments.push(comment);
      return { data: { addComment: { commentEdge: { node: { id: gid('comment', repo.id, issue.number, comment.id), body: comment.body } } } } };
    }
    return { data: null, errors: [{ message: 'Unknown mutation' }] };
  }
  if (query.includes('__type')) {
    // The query may alias each __type call (Issue: __type(...)); answer under the alias,
    // and answer every __type expression in the document.
    const out: Record<string, unknown> = {};
    const re = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(query)) !== null) {
      const alias = mm[1] ?? '__type';
      const tname = mm[2];
      if (tname === 'SearchType') {
        out[alias] = { name: tname, kind: 'ENUM', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'DISCUSSION' }] };
      } else {
        const fields = GQL_FIELDS[tname] ?? [];
        out[alias] = { name: tname, kind: 'OBJECT', fields: fields.map((f) => ({ name: f })) };
      }
    }
    if (Object.keys(out).length === 0) {
      const name = typeof v.name === 'string' ? v.name : '';
      const fields = GQL_FIELDS[name] ?? [];
      return { data: { __type: { name, kind: 'OBJECT', fields: fields.map((f) => ({ name: f })) } } };
    }
    return { data: out };
  }
  if (/node\s*\(/.test(query)) {
    const id = typeof v.id === 'string' ? v.id : '';
    const parts = parseGid(id);
    if (parts?.[0] === 'repo') {
      const repo = findRepoById(Number(parts[1]));
      if (!repo) return { data: { node: null } };
      const r = gqlRepo(repo);
      return { data: { node: { __typename: 'Repository', ...r } } };
    }
    if (parts?.[0] === 'issue') {
      const repo = findRepoById(Number(parts[1]));
      const issue = repo?.issues.get(Number(parts[2]));
      if (!repo || !issue) return { data: { node: null } };
      return { data: { node: { __typename: 'Issue', ...gqlIssue(repo, issue) } } };
    }
    if (parts?.[0] === 'pr') {
      const repo = findRepoById(Number(parts[1]));
      const pr = repo?.pulls.get(Number(parts[2]));
      if (!repo || !pr) return { data: { node: null } };
      return { data: { node: { __typename: 'PullRequest', ...gqlPR(repo, pr) } } };
    }
    return { data: { node: null } };
  }
  if (query.includes('repository(')) {
    const owner = typeof v.owner === 'string' ? v.owner : '';
    const name = typeof v.name === 'string' ? v.name : '';
    const repo = findRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const out: Record<string, unknown> = gqlRepo(repo);
    if (/issues\s*\(/.test(query)) {
      let list = [...repo.issues.values()];
      // states may arrive as a variable or inline in the query text (states: [OPEN]).
      const statesVar = Array.isArray(v.states) ? (v.states as string[]) : [];
      const inlineStates = query.match(/states\s*:\s*\[([^\]]*)\]/)?.[1].split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      const states = statesVar.length > 0 ? statesVar : inlineStates;
      if (states.includes('OPEN') && !states.includes('CLOSED')) list = list.filter((i) => i.state === 'open');
      if (states.includes('CLOSED') && !states.includes('OPEN')) list = list.filter((i) => i.state === 'closed');
      const orderBy = (v.orderBy ?? {}) as Record<string, unknown>;
      const inlineDirection = query.match(/direction\s*:\s*(ASC|DESC)/)?.[1];
      const desc = orderBy.direction === 'DESC' || inlineDirection === 'DESC';
      list.sort((a, c) => (desc ? c.number - a.number : a.number - c.number));
      const after = decodeCursor(typeof v.after === 'string' ? v.after : null);
      if (after !== null) list = list.filter((i) => (desc ? i.number < after : i.number > after));
      const first = typeof v.first === 'number' ? v.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > first;
      out.issues = {
        nodes: page.map((i) => gqlIssue(repo, i)),
        totalCount: list.length,
        pageInfo: { hasNextPage: hasNext, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null },
      };
    }
    if (/issue\s*\(/.test(query) && !/issues\s*\(/.test(query)) {
      const issue = repo.issues.get(Number(v.number));
      out.issue = issue ? gqlIssue(repo, issue) : null;
    } else if (/issue\s*\(/.test(query)) {
      const issue = repo.issues.get(Number(v.number));
      out.issue = issue ? gqlIssue(repo, issue) : null;
    }
    if (/pullRequests\s*\(/.test(query)) {
      let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
      const first = typeof v.first === 'number' ? v.first : list.length;
      const page = list.slice(0, first);
      out.pullRequests = { nodes: page.map((p) => gqlPR(repo, p)), totalCount: list.length, pageInfo: { hasNextPage: list.length > first, endCursor: null } };
    }
    if (/pullRequest\s*\(/.test(query)) {
      const pr = repo.pulls.get(Number(v.number));
      out.pullRequest = pr ? gqlPR(repo, pr) : null;
    }
    return { data: { repository: out } };
  }
  if (query.includes('viewer')) {
    return { data: { viewer: { login: VIEWER_LOGIN, id: gid('user', VIEWER_ID) } } };
  }
  return { data: {}, errors: [{ message: 'Unknown operation' }] };
}

function handleGraphQL(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  if (!authorized(req)) {
    sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((op) => {
      const o = (op ?? {}) as Record<string, unknown>;
      return executeGraphQL(typeof o.query === 'string' ? o.query : '', (o.variables ?? {}) as Record<string, unknown>);
    });
    sendJson(res, 200, results);
    return;
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const result = executeGraphQL(typeof o.query === 'string' ? o.query : '', (o.variables ?? {}) as Record<string, unknown>);
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP)
// ---------------------------------------------------------------------------

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string', description: 'owner/repo' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string', description: 'owner/repo' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string', description: 'owner/repo' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string', description: 'owner/repo' }, pull_number: { type: 'number', description: 'Pull request number' }, number: { type: 'number', description: 'Pull request number (alias)' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner || parts[0];
      repo = repo || parts[1];
    }
  }
  return { owner, repo };
}

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const id = o.id;
  const hasId = Object.prototype.hasOwnProperty.call(o, 'id');
  const method = typeof o.method === 'string' ? o.method : '';
  if (!hasId) {
    // Notification: no response body, 202.
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-06-18', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
    }));
    return;
  }
  if (method === 'initialize') {
    const params = (o.params ?? {}) as Record<string, unknown>;
    const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    if (!authorized(req)) {
      sendJson(res, 401, mcpError(id, -32001, 'Unauthorized'));
      return;
    }
    const params = (o.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = ((params.arguments ?? {}) as Record<string, unknown>);
    const tool = MCP_TOOLS.find((t) => {
      const tn = String(t.name);
      return tn === name || tn.toLowerCase().endsWith(name.toLowerCase()) || name.toLowerCase().endsWith(tn.toLowerCase());
    });
    if (!tool) {
      sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    const schema = tool.inputSchema as { required?: string[] };
    const required = schema.required ?? [];
    const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) {
      sendJson(res, 200, mcpResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument: ${missing[0]}` }) }],
        isError: true,
      }));
      return;
    }
    const toolName = String(tool.name);
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const textResult = (result: unknown): Record<string, unknown> => ({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    });
    if (toolName === 'create_repo') {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (!repoNameArg || !/^[A-Za-z0-9_.\-]+$/.test(repoNameArg)) {
        sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid repository name' }) }], isError: true }));
        return;
      }
      if (findRepo(VIEWER_LOGIN, repoNameArg)) {
        sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: 'Repository already exists' }) }], isError: true }));
        return;
      }
      const repo = createRepo(repoNameArg, typeof args.description === 'string' ? args.description : '', args.private === true);
      sendJson(res, 200, mcpResult(id, textResult(repoJson(repo))));
      return;
    }
    const repo = findRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: `Repository ${owner}/${repoName} not found` }) }], isError: true }));
      return;
    }
    if (toolName === 'get_repo') {
      sendJson(res, 200, mcpResult(id, textResult(repoJson(repo))));
      return;
    }
    if (toolName === 'create_issue') {
      const ts = nextTs();
      const issue: Issue = {
        number: repo.nextNumber++,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: [], comments: [],
        createdAt: isoTs(ts), updatedAt: isoTs(ts), createdTs: ts,
      };
      repo.issues.set(issue.number, issue);
      sendJson(res, 200, mcpResult(id, textResult(issueJson(repo, issue))));
      return;
    }
    if (toolName === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const arr = list.map((i) => issueJson(repo, i));
      sendJson(res, 200, mcpResult(id, textResult(arr)));
      return;
    }
    if (toolName === 'create_pull_request') {
      const result = createPR(
        repo,
        typeof args.title === 'string' ? args.title : '',
        typeof args.body === 'string' ? args.body : '',
        typeof args.head === 'string' ? args.head : '',
        typeof args.base === 'string' ? args.base : '',
      );
      if (!result.ok) {
        sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: result.message }) }], isError: true }));
        return;
      }
      sendJson(res, 200, mcpResult(id, textResult(prJson(repo, result.pr))));
      return;
    }
    if (toolName === 'merge_pull_request') {
      const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      const pr = repo.pulls.get(num);
      if (!pr) {
        sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: `Pull request #${num} not found` }) }], isError: true }));
        return;
      }
      const result = mergePR(repo, pr);
      if (!result.ok) {
        sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: result.message }) }], isError: true }));
        return;
      }
      sendJson(res, 200, mcpResult(id, textResult({ ...prJson(repo, pr), merged: true, sha: result.sha })));
      return;
    }
    sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${name}`));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;
  const query = url.searchParams;
  const seg = path.split('/').filter((s) => s.length > 0);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (seg.length >= 2 && seg[1].endsWith('.git')) {
    const owner = decodeURIComponent(seg[0]);
    const repoName = decodeURIComponent(seg[1].slice(0, -4));
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = findRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (seg[2] === 'info' && seg[3] === 'refs' && method === 'GET') {
      handleInfoRefs(req, res, repo, query.get('service') ?? '');
      return;
    }
    if (seg[2] === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, repo, await readBody(req));
      return;
    }
    if (seg[2] === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, repo, await readBody(req));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    handleGraphQL(req, res, await readBody(req));
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    handleMcp(req, res, await readBody(req));
    return;
  }

  if (seg[0] === 'api' && seg[1] === 'v3') {
    let body: unknown = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    if (handleRest(req, res, seg, query, body)) return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          try { res.end(); } catch { /* ignore */ }
        }
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
  });
}
