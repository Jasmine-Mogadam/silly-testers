import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

/**
 * Read-only access to the target repository's source code.
 * Used by agents to identify relevant files and attach code references to reports.
 */
export class RepoReader {
  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    if (!fs.existsSync(this.repoPath)) {
      throw new Error(`Repo path does not exist: ${this.repoPath}`);
    }
  }

  /**
   * Read a file relative to the repo root. Returns its text content.
   */
  readFile(relPath: string): string {
    const abs = path.join(this.repoPath, relPath);
    this.assertWithinRepo(abs);
    return fs.readFileSync(abs, 'utf8');
  }

  /**
   * Read a file and return only the lines around a specific line number (±context).
   */
  readFileLines(relPath: string, line: number, context = 5): string {
    const content = this.readFile(relPath);
    const lines = content.split('\n');
    const start = Math.max(0, line - context - 1);
    const end = Math.min(lines.length, line + context);
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  }

  /**
   * List all files matching a glob-like pattern.
   * Uses find or ripgrep if available, otherwise falls back to recursive walk.
   */
  listFiles(extension?: string): string[] {
    const results: string[] = [];
    this.walk(this.repoPath, results, extension);
    return results.map((f) => path.relative(this.repoPath, f));
  }

  /**
   * Search for a regex pattern across the repo.
   * Uses ripgrep if available, otherwise falls back to line-by-line search.
   */
  searchCode(pattern: string, fileExtension?: string): SearchResult[] {
    // Try ripgrep first for speed
    try {
      return this.searchWithRipgrep(pattern, fileExtension);
    } catch {
      return this.searchFallback(pattern, fileExtension);
    }
  }

  /**
   * Get a high-level summary of the repo structure (top-level files + dirs).
   */
  getStructure(depth = 2): string {
    return this.buildTree(this.repoPath, depth, 0);
  }

  /**
   * Check if a file exists within the repo.
   */
  exists(relPath: string): boolean {
    const abs = path.join(this.repoPath, relPath);
    try {
      this.assertWithinRepo(abs);
      return fs.existsSync(abs);
    } catch {
      return false;
    }
  }

  private assertWithinRepo(absPath: string): void {
    const rel = path.relative(this.repoPath, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escape attempt: ${absPath}`);
    }
  }

  private walk(dir: string, results: string[], ext?: string): void {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          this.walk(fullPath, results, ext);
        }
      } else if (entry.isFile()) {
        if (!ext || entry.name.endsWith(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  private searchWithRipgrep(pattern: string, ext?: string): SearchResult[] {
    const typeFlag = ext ? `--glob "*.${ext.replace(/^\./, '')}"` : '';
    const cmd = `rg --line-number --no-heading --color=never ${typeFlag} ${JSON.stringify(pattern)} ${JSON.stringify(this.repoPath)}`;

    const output = execSync(cmd, { encoding: 'utf8', timeout: 15_000 });
    return this.parseRipgrepOutput(output);
  }

  private parseRipgrepOutput(output: string): SearchResult[] {
    const results: SearchResult[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (match) {
        results.push({
          file: path.relative(this.repoPath, match[1]),
          line: parseInt(match[2], 10),
          content: match[3],
        });
      }
    }
    return results;
  }

  private searchFallback(pattern: string, ext?: string): SearchResult[] {
    const files: string[] = [];
    this.walk(this.repoPath, files, ext);

    const regex = new RegExp(pattern, 'i');
    const results: SearchResult[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        lines.forEach((lineContent, idx) => {
          if (regex.test(lineContent)) {
            results.push({
              file: path.relative(this.repoPath, file),
              line: idx + 1,
              content: lineContent,
            });
          }
        });
      } catch {
        // skip unreadable files
      }
    }

    return results;
  }

  private buildTree(dir: string, maxDepth: number, currentDepth: number): string {
    if (currentDepth >= maxDepth) return '';

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
    let output = '';

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return output;
    }

    for (const entry of entries) {
      const indent = '  '.repeat(currentDepth);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          output += `${indent}${entry.name}/\n`;
          output += this.buildTree(path.join(dir, entry.name), maxDepth, currentDepth + 1);
        }
      } else {
        output += `${indent}${entry.name}\n`;
      }
    }

    return output;
  }
}
