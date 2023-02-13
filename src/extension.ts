import * as child_process from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import type * as git from "./git";

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(
      onDidChangeTextEditorSelection,
    ),
    vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument),
    vscode.workspace.onDidSaveTextDocument(onDidSaveTextDocument),
  );
  await loadGitApi();
}

export function deactivate() {
  // TODO
}

let gitApi: git.API;

async function loadGitApi() {
  const extension =
    vscode.extensions.getExtension<git.GitExtension>("vscode.git");
  if (extension === undefined) {
    vscode.window.showErrorMessage("Failed to load Git extension");
    return;
  }
  const exports = extension.isActive
    ? extension.exports
    : await extension.activate();
  const api = exports.getAPI(1);
  api.onDidChangeState(async (state) => {
    if (state === "initialized") {
      console.log(`git API initialized with ${api.repositories.length} repos`);
      gitApi = api;
      await Promise.all(
        vscode.window.visibleTextEditors.map((editor) =>
          onDidOpenTextDocument(editor.document),
        ),
      );
      const active = vscode.window.activeTextEditor;
      if (active !== undefined) {
        await onDidChangeTextEditorSelection({
          textEditor: active,
          selections: active.selections,
          kind: undefined,
        });
      }
    }
  });
}

const userEmailCache = new Map<string, string>();

async function getUserEmail(repo: git.Repository): Promise<string> {
  const path = repo.rootUri.fsPath;
  const email = userEmailCache.get(path);
  if (email !== undefined) return email;
  const value = (await gitStdout(repo, ["config", "user.email"])).trim();
  userEmailCache.set(path, value);
  return value;
}

interface Commit {
  author: string;
  email: string;
  // Author's timestamp, in epoch seconds.
  timestamp: number;
  // First line of the commit message.
  summary: string;
  // Markdown message to display on hover.
  message?: string[];
}

// Full git commit SHA.
type Sha = string;

// An array of SHAs, one per zero-based line.
type Blame = Sha[];

const shaToCommit = new Map<Sha, Commit>();
const pathToBlame = new Map<string, Blame | "untracked">();

async function onDidOpenTextDocument(document: vscode.TextDocument) {
  const uri = document.uri;
  if (uri.scheme !== "file") return;
  if (pathToBlame.has(uri.fsPath)) return;
  if (gitApi === undefined) return;
  await loadBlameForFile(uri);
}

function onDidSaveTextDocument(document: vscode.TextDocument) {
  console.log("saved text document");
}

async function loadBlameForFile(uri: vscode.Uri) {
  console.log(`loading blame for ${uri}`);
  const repo = gitApi.getRepository(uri);
  if (!repo) {
    console.error(`no repo found for file: ${uri}`);
    return;
  }
  const userEmail = await getUserEmail(repo);
  const proc = gitSpawn(
    repo,
    ["blame", "--incremental", "--", uri.fsPath],
    (code) => {
      if (code === 128) {
        pathToBlame.set(uri.fsPath, "untracked");
      } else if (code !== 0) {
        console.error(`git blame failed with exit code ${code}`);
      }
    },
  );
  const blame: string[] = [];
  pathToBlame.set(uri.fsPath, blame);
  let expectSha = true;
  let commit = undefined;
  for await (const line of readline.createInterface({ input: proc.stdout })) {
    if (expectSha) {
      expectSha = false;
      const words = line.split(" ");
      const sha = words[0];
      const start = parseInt(words[2]) - 1;
      const num = parseInt(words[3]);
      for (let i = start; i < start + num; i++) {
        blame[i] = sha;
      }
      if (!shaToCommit.has(sha)) {
        commit = {} as Commit;
        shaToCommit.set(sha, commit);
      } else {
        commit = undefined;
      }
      continue;
    }
    const idx = line.indexOf(" ");
    const tag = line.substring(0, idx);
    if (tag === "filename") {
      expectSha = true;
      continue;
    }
    if (commit === undefined) continue;
    const content = line.substring(idx + 1);
    switch (tag) {
      case "author":
        if (commit.author === undefined) {
          commit.author = content;
        }
        break;
      case "author-mail":
        commit.email = content.replace(/[<>]/g, "");
        if (commit.email === userEmail) {
          commit.author = "You";
        }
        break;
      case "author-time":
        commit.timestamp = parseInt(content);
        break;
      case "summary":
        commit.summary = truncateEllipsis(content.trim(), 50);
        break;
    }
  }
}

const decorationType = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  after: {
    color: new vscode.ThemeColor("gitlineblame.foregroundColor"),
    margin: "0 0 0 3em",
  },
});

// Closed range of zero-based line numbers, with `start <= end`.
interface LineRange {
  start: number;
  end: number;
}

function lineRange({ start, end }: vscode.Range): LineRange {
  return { start: start.line, end: end.line };
}

function linesRangesEqual(r1: LineRange, r2: LineRange): boolean {
  return r1.start === r2.start && r1.end === r2.end;
}

const pathToLastRange = new Map<string, LineRange>();

const maxLineDecorations = 200;

async function onDidChangeTextEditorSelection(
  event: vscode.TextEditorSelectionChangeEvent,
) {
  const editor = event.textEditor;
  const uri = editor.document.uri;
  if (uri.scheme !== "file") return;
  const path = uri.fsPath;
  const range = lineRange(event.selections[0]);
  const last = pathToLastRange.get(path);
  if (last !== undefined && linesRangesEqual(range, last)) return;
  pathToLastRange.set(path, range);
  const blame = pathToBlame.get(path);
  if (blame === undefined) {
    editor.setDecorations(decorationType, []);
    return;
  }
  const repo = gitApi.getRepository(uri);
  if (!repo) {
    console.error(`no repo found for file: ${uri}`);
    return;
  }
  const decorationOptions = [];
  let lastSha = undefined;
  const rangeEnd = Math.min(range.end, blame.length - 1);
  const limit = range.start + maxLineDecorations;
  const logPromises = [];
  for (let i = range.start; i <= rangeEnd; i++) {
    const sha = blame[i];
    if (sha === lastSha) continue;
    lastSha = sha;
    const end = editor.document.lineAt(i).range.end;
    const option = {
      range: new vscode.Range(end, end),
      renderOptions: {
        after: { contentText: undefined as string | undefined },
      },
      hoverMessage: undefined as string[] | undefined,
    };
    if (i > limit) {
      option.renderOptions.after.contentText = "[Exceeded git blame limit]";
      decorationOptions.push(option);
      break;
    }
    const commit = shaToCommit.get(sha);
    let text;
    if (commit === undefined) {
      option.renderOptions.after.contentText =
        "[Failed to get git blame information]";
    } else {
      const when = friendlyTimestamp(commit.timestamp);
      option.renderOptions.after.contentText = `${commit.author}, ${when} • ${commit.summary}`;
      if (commit.message === undefined) {
        logPromises.push(loadCommitMessage(sha, repo, when, commit, option));
      } else {
        option.hoverMessage = commit.message;
      }
    }
    decorationOptions.push(option);
  }
  await Promise.all(logPromises);
  editor.setDecorations(decorationType, decorationOptions);
}

async function loadCommitMessage(
  sha: Sha,
  repo: git.Repository,
  when: string,
  commit: Commit,
  option: vscode.DecorationOptions,
) {
  const date = isoTimestamp(commit.timestamp);
  const commitMsg = await gitStdout(repo, ["show", "-s", "--format=%B", sha]);
  let message = [`[**${commit.author}**](mailto:${commit.email} "${commit.email}"), ${when} (${date})\n\n${commitMsg}`, "TEST"];
  commit.message = message;
  option.hoverMessage = message;
}

function gitSpawn(
  repo: git.Repository,
  args: string[],
  onClose?: (code: number) => void,
): child_process.ChildProcessWithoutNullStreams {
  const fullArgs = ["-C", repo.rootUri.fsPath, ...args];
  const proc = child_process.spawn(gitApi.git.path, fullArgs);
  if (onClose !== undefined) {
    proc.on("close", onClose);
  } else {
    proc.on("close", (code) => {
      if (code === 0) return;
      console.error(
        `${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`,
      );
    });
  }
  return proc;
}

async function gitStdout(
  repo: git.Repository,
  args: string[],
): Promise<string> {
  let result = "";
  for await (const data of gitSpawn(repo, args).stdout) {
    result += data;
  }
  return result;
}

function isoTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function friendlyTimestamp(timestamp: number): string {
  const s = Math.round(Date.now() / 1000 - timestamp);
  if (s < 30) return "just now";
  const m = s / 60;
  if (m < 1) return Math.round(s) + " seconds ago";
  if (m < 1.5) return "a minute ago";
  const h = m / 60;
  if (h < 1) return Math.round(m) + " minutes ago";
  if (h < 1.5) return "an hour ago";
  const d = h / 24;
  if (d < 1) return Math.round(h) + " hours ago";
  if (d < 1.5) return "yesterday";
  const w = d / 7;
  if (w < 1) return Math.round(d) + " days ago";
  if (w < 1.5) return "last week";
  const mm = w / 4.3333333333;
  if (mm < 1) return Math.round(w) + " weeks ago";
  if (mm < 1.5) return "last month";
  const y = d / 365.25;
  if (y < 1) return Math.round(mm) + " months ago";
  if (y < 1.5) return "last year";
  return Math.round(y) + " years ago";
}

function truncateEllipsis(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 1) + "…";
}
