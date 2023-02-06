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
let queuedFiles: vscode.Uri[];

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
  api.onDidChangeState((state) => {
    if (state === "initialized") {
      console.log(`git API initialized with ${api.repositories.length} repos`);
      gitApi = api;
      queuedFiles.forEach(initializeFile);
      queuedFiles = [];
    }
  });
}

interface Commit {
  author: string;
  email: string;
  // Author's timestamp, in ms since epoch.
  timestamp: number;
  summary: string;
  message?: string;
}

const shaToCommit = new Map<string, Commit>();
const pathToLineShas = new Map<string, string[] | undefined>();

async function onDidOpenTextDocument(document: vscode.TextDocument) {
  const uri = document.uri;
  if (uri.scheme !== "file") return;
  if (pathToLineShas.has(uri.fsPath)) return;
  if (gitApi === undefined) {
    queuedFiles.push(uri);
  } else {
    await initializeFile(uri);
  }
}

function onDidSaveTextDocument(document: vscode.TextDocument) {
  console.log("saved text document");
}

async function initializeFile(uri: vscode.Uri) {
  const repo = gitApi.getRepository(uri);
  if (!repo) {
    console.error(`no repo found for file: ${uri}`);
    return;
  }
  const blame = child_process.spawn(gitApi.git.path, [
    "-C",
    repo.rootUri.fsPath,
    "blame",
    "--incremental",
    "--",
    uri.fsPath,
  ]);
  blame.on("close", (code) => {
    switch (code) {
      case 0:
        break;
      case 128:
        pathToLineShas.set(uri.fsPath, undefined);
        break;
      default:
        console.error(`git blame failed with exit code ${code}`);
        break;
    }
  });
  const lines: string[] = [];
  pathToLineShas.set(uri.fsPath, lines);
  let expectSha = true;
  let commit = undefined;
  for await (const line of readline.createInterface({ input: blame.stdout })) {
    if (expectSha) {
      expectSha = false;
      const words = line.split(" ");
      const sha = words[0];
      const start = parseInt(words[2]) - 1;
      const num = parseInt(words[3]);
      for (let i = start; i < start + num; i++) {
        lines[i] = sha;
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
        commit.author = content;
        break;
      case "summary":
        commit.summary = content;
        break;
      case "author-mail":
        commit.email = content;
        break;
      case "author-time":
        commit.timestamp = parseInt(content);
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

function onDidChangeTextEditorSelection(
  event: vscode.TextEditorSelectionChangeEvent,
) {
  const uri = event.textEditor.document.uri;
  if (uri.scheme !== "file") return;
  const lineShas = pathToLineShas.get(uri.fsPath);
  if (lineShas === undefined) {
    event.textEditor.setDecorations(decorationType, []);
    return;
  }
  const numbers = Array.from(selectedLineNumbers(event.selections));
  event.textEditor.setDecorations(
    decorationType,
    numbers.map((line) => {
      const commit = shaToCommit.get(lineShas[line]);
      let contentText;
      if (commit === undefined) {
        contentText = "FAILED TO GET BLAME INFORMATION";
      } else {
        const when = friendlyTimestamp(commit.timestamp);
        contentText = `${commit.author}, ${when} • ${commit.summary}`;
      }
      return {
        range: event.textEditor.document.lineAt(line).range,
        hoverMessage: "TODO commit",
        renderOptions: { after: { contentText } },
      };
    }),
  );
}

function selectedLineNumbers(
  selections: readonly vscode.Selection[],
): Set<number> {
  const lines = new Set<number>();
  for (const selection of selections) {
    const from = Math.min(selection.start.line, selection.end.line);
    const to = Math.max(selection.start.line, selection.end.line);
    for (let i = from; i <= to; i++) {
      lines.add(i);
    }
  }
  return lines;
}

function friendlyTimestamp(timestamp: number): string {
  const s = Math.round(Date.now() / 1000 - timestamp);
  if (s < 30) return "just now";
  const m = Math.floor(s / 60);
  if (m === 0) return s + " seconds ago";
  if (m === 1) return "a minute ago";
  const h = Math.floor(m / 60);
  if (h === 0) return m + " minutes ago";
  if (h === 1) return "an hour ago";
  const d = Math.floor(h / 24);
  if (d === 0) return h + " hours ago";
  if (d === 1) return "yesterday";
  const w = Math.floor(d / 7);
  if (w === 0) return d + " days ago";
  if (w === 1) return "a week ago";
  const mm = Math.floor(w / 4.3333333333);
  if (mm === 0) return w + " weeks ago";
  if (mm === 1) return "a month ago";
  const y = Math.floor(d / 365.25);
  if (y === 0) return mm + " months ago";
  if (y === 1) return "a year ago";
  return y + " years ago";
}
