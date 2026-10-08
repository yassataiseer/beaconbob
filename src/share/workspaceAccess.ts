import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import {
  type DocErrorCode,
  isSharePath,
  MAX_DIR_ENTRIES,
  MAX_SHARED_FILE_BYTES,
  type SharedDirEntry,
  type SharedStat,
} from './shareProtocol';

export const DEFAULT_SHARING_EXCLUDES = ['.git/', 'node_modules/', '.env', '.env.*', '*.pem', '*.key', 'id_rsa*'];

export class ShareFsError extends Error {
  constructor(
    readonly code: DocErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ShareFsError';
  }
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * The host's view of its shared folder, as guests are allowed to see it. Every path is
 * checked: well-formed, not ignored (root `.gitignore` plus the exclude setting), and its
 * real path (after symlinks) still inside the shared root.
 */
export class WorkspaceAccess {
  private ig: Ignore;

  private constructor(
    readonly root: string,
    private readonly realRoot: string,
    private readonly excludes: string[],
  ) {
    this.ig = ignore();
  }

  static async create(root: string, excludes: string[] = DEFAULT_SHARING_EXCLUDES): Promise<WorkspaceAccess> {
    const realRoot = await fs.realpath(root);
    const access = new WorkspaceAccess(path.resolve(root), realRoot, excludes);
    await access.reloadIgnore();
    return access;
  }

  get rootName(): string {
    return path.basename(this.root) || this.root;
  }

  /** Re-reads the root `.gitignore` (call when it changes). */
  async reloadIgnore(): Promise<void> {
    const ig = ignore().add(this.excludes);
    try {
      ig.add(await fs.readFile(path.join(this.realRoot, '.gitignore'), 'utf8'));
    } catch {
      // No .gitignore: only the exclude setting applies.
    }
    this.ig = ig;
  }

  /** True if `rel` and every folder above it are visible to guests. */
  isVisible(rel: string, isDirectory = false): boolean {
    if (rel === '') return true;
    const segments = rel.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const dir = i < segments.length || isDirectory;
      if (this.ig.ignores(dir ? `${prefix}/` : prefix)) return false;
    }
    return true;
  }

  /** Maps an absolute path on the host to a shared relative path, if it is one. */
  toRelative(absolute: string): string | undefined {
    const rel = path.relative(this.root, absolute);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? '' : undefined;
    const posix = rel.split(path.sep).join('/');
    return isSharePath(posix) ? posix : undefined;
  }

  absolute(rel: string): string {
    return path.join(this.root, ...rel.split('/').filter(Boolean));
  }

  async stat(rel: string): Promise<SharedStat> {
    const { stats } = await this.resolve(rel);
    return {
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      mtime: Math.floor(stats.mtimeMs),
      ctime: Math.floor(stats.ctimeMs),
    };
  }

  async readDir(rel: string): Promise<SharedDirEntry[]> {
    const { real, stats } = await this.resolve(rel);
    if (!stats.isDirectory()) throw new ShareFsError('not-a-directory');
    const names = (await fs.readdir(real)).sort();
    const entries: SharedDirEntry[] = [];
    for (const name of names) {
      if (entries.length >= MAX_DIR_ENTRIES) break;
      const child = rel ? `${rel}/${name}` : name;
      if (!isSharePath(child)) continue;
      try {
        const resolved = await this.resolve(child);
        entries.push({ name, type: resolved.stats.isDirectory() ? 'directory' : 'file' });
      } catch {
        // Ignored, escapes the root through a symlink, or vanished: guests do not see it.
      }
    }
    return entries;
  }

  async readBytes(rel: string): Promise<Buffer> {
    const { real, stats } = await this.resolve(rel);
    if (!stats.isFile()) throw new ShareFsError('not-a-file');
    if (stats.size > MAX_SHARED_FILE_BYTES) throw new ShareFsError('too-large');
    return fs.readFile(real);
  }

  /** UTF-8 text of a file, refusing binary files. */
  async readText(rel: string): Promise<string> {
    const bytes = await this.readBytes(rel);
    if (isBinary(bytes)) throw new ShareFsError('binary');
    return bytes.toString('utf8');
  }

  private async resolve(rel: string): Promise<{ real: string; stats: import('node:fs').Stats }> {
    if (!isSharePath(rel)) throw new ShareFsError('forbidden', 'Malformed path');
    let real: string;
    try {
      real = await fs.realpath(this.absolute(rel));
    } catch {
      throw new ShareFsError('not-found');
    }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
      throw new ShareFsError('forbidden', 'Outside the shared folder');
    }
    const stats = await fs.stat(real).catch(() => {
      throw new ShareFsError('not-found');
    });
    // Ignore rules apply to the path as the guest sees it and to where it really points.
    const realRel = path.relative(this.realRoot, real).split(path.sep).join('/');
    if (!this.isVisible(rel, stats.isDirectory()) || !this.isVisible(realRel, stats.isDirectory())) {
      throw new ShareFsError('not-found');
    }
    return { real, stats };
  }
}
