import * as child_process from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import type * as git from "./git";

let log: vscode.LogOutputChannel;
let blameDecoration: vscode.TextEditorDecorationType;
let gitApi: git.API;

const cache = new Map<string, Repository>();
const editorUpdateId = new Map<vscode.TextEditor, number>();

interface Repository {
  gitRepo: git.Repository,
  email?: string;
  head: Ref;
  files: Map<string, File>;
  commits: Map<Sha, Commit>;
}

interface File {
  state: "loading" | "done" | "dirty";
  tracked: "yes" | "no" | "unknown";
  blame: Ref[]; // refs indexed by 0-based line number
  pendingChanges: vscode.TextDocumentContentChangeEvent[];
  pendingEditors: Set<vscode.TextEditor>;
}

type Sha = string;
const uncommitted = Symbol("uncommited");
type Ref = Sha | typeof uncommitted;

interface Commit {
  author: string;
  email: string;
  timestamp: number; // Unix timestamp in seconds
  summary: string;
  prevFilename?: string;
  filename: string;
  message?: string; // loaded on demand
}

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    log = vscode.window.createOutputChannel("Better Git Line Blame", { log: true }),
    blameDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
      after: {
        color: new vscode.ThemeColor("betterGitLineBlame.foregroundColor"),
        margin: "0 0 0 3em",
      },
    })
  );
  const extension = vscode.extensions.getExtension<git.GitExtension>("vscode.git");
  if (!extension) {
    log.appendLine("not in a git repository");
    return;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const api = exports.getAPI(1);
  const initialize = async () => {
    log.appendLine(`git API initialized with ${api.repositories.length} repo(s)`);
    gitApi = api;
    for (const repo of api.repositories) addRepository(repo);
    context.subscriptions.push(
      api.onDidOpenRepository(addRepository),
      api.onDidCloseRepository(removeRepository),
      vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument),
      vscode.workspace.onDidSaveTextDocument(onDidSaveTextDocument),
      vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
      vscode.window.onDidChangeTextEditorSelection(onDidChangeTextEditorSelection),
      vscode.commands.registerCommand("betterGitLineBlame.clearCache", commandClearCache),
      vscode.commands.registerTextEditorCommand("betterGitLineBlame.reblameFile", commandReblameFile),
    );
    updateEditor(vscode.window.activeTextEditor);
    await Promise.all(
      vscode.window.visibleTextEditors.map((editor) => onDidOpenTextDocument(editor.document))
    );
    let numFiles = 0;
    for (const repo of cache.values()) numFiles += repo.files.size;
    log.appendLine(`blamed ${numFiles} initial file(s)`);
    updateEditor(vscode.window.activeTextEditor);
  };
  if (api.state === "initialized") {
    await initialize();
  } else {
    const listener = api.onDidChangeState((state) => {
      listener.dispose();
      if (state === "initialized") initialize();
    });
    context.subscriptions.push(listener);
  }
}

export function deactivate() { cache.clear(); }

function addRepository(gitRepo: git.Repository): Repository {
  const path = gitRepo.rootUri.fsPath;
  const existing = cache.get(path);
  if (existing) return existing;
  log.appendLine(`adding git repo: ${path}`);
  const repo: Repository = {
    gitRepo,
    head: gitRepo.state.HEAD?.commit ?? uncommitted,
    files: new Map(),
    commits: new Map(),
  };
  cache.set(path, repo);
  gitStdout(gitRepo, ["config", "user.email"]).then((output) => repo.email = output.trim());
  return repo;
}

function removeRepository(gitRepo: git.Repository) { cache.delete(gitRepo.rootUri.fsPath); }

function commandClearCache() { for (const repo of cache.values()) repo.files.clear(); }

function commandReblameFile(editor: vscode.TextEditor) {
  const repo = getRepo(editor.document.uri);
  if (!repo) return;
  const file = repo.files.get(editor.document.uri.fsPath);
  if (file) reloadFile(repo, file, editor.document, editor);
  else loadFile(repo, editor.document, editor);
  updateEditor(editor);
}

function onDidOpenTextDocument(document: vscode.TextDocument) {
  const repo = getRepo(document.uri);
  if (repo && !repo.files.has(document.uri.fsPath)) loadFile(repo, document);
}

function onDidSaveTextDocument(document: vscode.TextDocument) {
  const repo = getRepo(document.uri);
  if (!repo) return;
  const file = repo.files.get(document.uri.fsPath);
  if (!file) return;
  if (file.tracked === "no") return;
  if (file.state === "dirty") reloadFile(repo, file, document);
  updateEditor(vscode.window.activeTextEditor, document);
}

function loadFile(repo: Repository, document: vscode.TextDocument, ...editors: vscode.TextEditor[]) {
  const file: File = { state: "loading", tracked: "unknown", blame: [], pendingChanges: [], pendingEditors: new Set(editors) };
  repo.files.set(document.uri.fsPath, file);
  loadBlameForDocument(repo, file, document);
  return file;
}

function reloadFile(repo: Repository, file: File, document: vscode.TextDocument, ...editors: vscode.TextEditor[]) {
  if (file.state === "loading") return;
  file.state = "loading";
  file.blame = [];
  file.pendingChanges = [];
  file.pendingEditors = new Set(editors);
  loadBlameForDocument(repo, file, document);
}

function loadBlameForDocument(repo: Repository, file: File, document: vscode.TextDocument) {
  const path = document.uri.fsPath;
  if (!document.isDirty) {
    loadBlameForFile(repo, file, path);
    return;
  }
  file.state = "dirty";
  if (file.tracked !== "unknown") return;
  const proc = gitSpawn(repo.gitRepo, ["ls-files", "--error-unmatch", path]).on("close", (code) => {
    if (code === 0) {
      file.tracked = "yes";
      updateEditor(vscode.window.activeTextEditor, document);
    } else if (code === 1) {
      file.tracked = "no";
    } else {
      log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`);
    }
  });
}

function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
  const repo = getRepo(event.document.uri);
  if (!repo) return;
  const document = event.document;
  const file = repo.files.get(document.uri.fsPath);
  if (!file || file.tracked === "no") return;
  switch (file.state) {
    case "loading": file.pendingChanges.push(...event.contentChanges); break;
    case "done": for (const change of event.contentChanges) processChange(file, change); break;
    case "dirty": break;
  }
  // If we added or removed a line, update the editor since it's possible the
  // selection didn't change and onDidChangeTextEditorSelection won't fire.
  if (event.contentChanges.length !== 0) {
    const change = event.contentChanges[0];
    if (!change.range.isSingleLine || change.text.includes("\n"))
      updateEditor(vscode.window.activeTextEditor, document);
  }
}

function processChange(file: File, change: vscode.TextDocumentContentChangeEvent) {
  const start = change.range.start.line;
  const end = change.range.end.line;
  const lines = change.text.split("\n");
  const newEnd = start + lines.length - 1;
  for (let i = start; i <= Math.min(end, newEnd); i++) file.blame[i] = uncommitted;
  if (newEnd < end) file.blame.splice(newEnd + 1, end - newEnd);
  else if (newEnd > end) file.blame.splice(end + 1, 0, ...Array(newEnd - end).fill(uncommitted));
}

function updateEditor(editor?: vscode.TextEditor, document?: vscode.TextDocument) {
  if (!editor) return;
  if (document && editor.document !== document) return;
  onDidChangeTextEditorSelection({ textEditor: editor, selections: editor.selections, kind: undefined });
}

async function onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent) {
  const editor = event.textEditor;
  const repo = getRepo(editor.document.uri);
  if (!repo) return;
  const file = repo.files.get(editor.document.uri.fsPath) ?? loadFile(repo, editor.document, editor);
  if (file.tracked !== "yes") return editor.setDecorations(blameDecoration, []);
  const startLine = event.selections[0].start.line;
  const endLine = event.selections[0].end.line;
  const actualHead = repo.gitRepo.state.HEAD?.commit;
  if (repo.head !== actualHead) {
    const newHead = actualHead ?? uncommitted;
    log.appendLine(`${repo.gitRepo.rootUri.fsPath}: detected HEAD change from ${String(repo.head)} to ${String(newHead)}`);
    repo.head = newHead;
    repo.files.clear();
    reloadFile(repo, file, editor.document, editor);
  }
  const decorationOptions = [];
  let lastRef = null;
  const configuration = vscode.workspace.getConfiguration("betterGitLineBlame");
  const maxBlamedLines = configuration.maxBlamedLines === 0 ? Infinity : configuration.maxBlamedLines;
  const maxSummaryLength = configuration.maxSummaryLength === 0 ? Infinity : configuration.maxSummaryLength;
  const logPromises = [];
  for (let i = startLine; i <= endLine; i++) {
    const ref = file.blame[i];
    if (ref === lastRef) continue;
    lastRef = ref;
    const option = {
      range: editor.document.lineAt(i).range,
      renderOptions: {
        after: { contentText: undefined as string | undefined },
      },
      hoverMessage: undefined as vscode.MarkdownString[] | undefined,
    };
    if (i >= startLine + maxBlamedLines) {
      if (maxBlamedLines > 1) {
        option.renderOptions.after.contentText = "(Exceeded max blamed lines)";
        decorationOptions.push(option);
      }
      break;
    }
    let commit;
    if (file.state === "dirty") {
      if (file.tracked === "yes") option.renderOptions.after.contentText = "(Save to blame)";
    } else if (ref === undefined) {
      if (i !== editor.document.lineCount - 1) option.renderOptions.after.contentText = "Loading blame…";
    } else if (ref === uncommitted) {
      option.renderOptions.after.contentText = "You • Uncommitted changes";
    } else if ((commit = repo.commits.get(ref)) === undefined) {
      option.renderOptions.after.contentText =
        "(Failed to get git blame information)";
    } else {
      const who = commit.email === repo.email ? "You" : commit.author;
      const when = friendlyTimestamp(commit.timestamp);
      const summary = truncateEllipsis(commit.summary, maxSummaryLength);
      option.renderOptions.after.contentText = `${who}, ${when} • ${summary}`;
      if (commit.message === undefined) {
        logPromises.push((async () => {
          const rawMessage = await gitStdout(repo.gitRepo, ["show", "-s", "--format=%B", ref]);
          // Convert to hard line breaks for Markdown.
          commit.message = rawMessage.replace(/\n/g, "  \n");
          option.hoverMessage = buildHoverMessage(ref, commit, when);
        })());
      } else {
        option.hoverMessage = buildHoverMessage(ref, commit, when);
      }
    }
    decorationOptions.push(option);
  }
  if (file.state === "loading") file.pendingEditors.add(editor);
  editor.setDecorations(blameDecoration, decorationOptions);
  const updateId = (editorUpdateId.get(editor) ?? 0) + 1;
  editorUpdateId.set(editor, updateId);
  await Promise.all(logPromises);
  if (logPromises.length !== 0 && editorUpdateId.get(editor) === updateId)
    editor.setDecorations(blameDecoration, decorationOptions);
}

function buildHoverMessage(sha: Sha, commit: Commit, when: string) {
  const command = vscode.Uri.from({
    scheme: "command",
    path: "vscode.diff",
    query: JSON.stringify([gitUri(sha + "~", commit.prevFilename ?? commit.filename), gitUri(sha, commit.filename)]),
  });
  // Prevent automatic mailto link.
  const email = commit.email.replace("@", "&#64;");
  return [
    trusted(`**${commit.author}** <${email}>, ${when} (${isoDate(commit.timestamp)})\n\n${commit.message}`),
    trusted(`[Show diff](${command}): ${sha}`),
  ];
}

function gitUri(ref: Sha, path: string) {
  return vscode.Uri.from({
    scheme: "git",
    path: path,
    query: JSON.stringify({ ref, path }),
  });
}

function trusted(str: string) {
  const markdown = new vscode.MarkdownString(str);
  markdown.isTrusted = true;
  return markdown;
}

function getRepo(uri: vscode.Uri) {
  if (!gitApi) return;
  if (uri.scheme !== "file") return;
  const gitRepo = gitApi.getRepository(uri);
  if (!gitRepo) return;
  return addRepository(gitRepo);
}

async function loadBlameForFile(repo: Repository, file: File, path: string) {
  log.appendLine(`loading blame: ${path}`);
  const configuration = vscode.workspace.getConfiguration("betterGitLineBlame");
  const flags = ["--incremental"];
  if (configuration.ignoreWhitespaceChanges) flags.push("-w");
  const proc = gitSpawn(repo.gitRepo, ["blame", ...flags, "--", path]);
  const exitCode = new Promise(resolve => proc.on("close", resolve));
  const rootSlash = repo.gitRepo.rootUri.fsPath + "/";
  let expectSha = true;
  let commit = undefined;
  for await (const line of readline.createInterface({ input: proc.stdout })) {
    if (expectSha) {
      expectSha = false;
      const words = line.split(" ");
      const sha = words[0];
      const ref = sha === "0000000000000000000000000000000000000000" ? uncommitted : sha;
      const start = parseInt(words[2]) - 1;
      const num = parseInt(words[3]);
      for (let i = start; i < start + num; i++) file.blame[i] = ref;
      if (ref !== uncommitted && !repo.commits.has(sha))
        repo.commits.set(sha, commit = {} as Commit);
      else
        commit = undefined;
      file.tracked = "yes"
      continue;
    }
    const idx = line.indexOf(" ");
    const tag = line.substring(0, idx);
    if (tag === "filename") expectSha = true;
    if (!commit) continue;
    const content = line.substring(idx + 1);
    switch (tag) {
      case "author":
        if (!commit.author) commit.author = content;
        break;
      case "author-mail":
        commit.email = content.replace(/[<>]/g, "");
        break;
      case "author-time":
        commit.timestamp = parseInt(content);
        break;
      case "summary":
        commit.summary = content.trim();
        break;
      case "previous":
        commit.prevFilename = rootSlash + content.substring(content.indexOf(" ") + 1);
        break;
      case "filename":
        commit.filename = rootSlash + content;
        break;
    }
  }
  const code = await exitCode;
  if (code === 0) file.tracked = "yes";
  else if (code === 128) file.tracked = "no";
  else log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`)
  file.state = "done";
  if (code === 0) for (const change of file.pendingChanges) processChange(file, change);
  file.pendingChanges = [];
  const editors = Array.from(file.pendingEditors);
  file.pendingEditors.clear();
  await Promise.all(editors.map((editor) => updateEditor(editor)));
}

function gitSpawn(repo: git.Repository, args: string[]) {
  return child_process.spawn(gitApi.git.path, ["-C", repo.rootUri.fsPath, ...args]);
}

async function gitStdout(repo: git.Repository, args: string[]) {
  const proc = gitSpawn(repo, args);
  proc.on("close", (code) => {
    if (code !== 0) log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`);
  });
  let result = "";
  for await (const data of proc.stdout) result += data;
  return result;
}

function isoDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, { dateStyle: "medium" });
}

function friendlyTimestamp(timestamp: number) {
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

function truncateEllipsis(str: string, maxLen: number) {
  return str.length <= maxLen ? str : str.substring(0, maxLen - 1) + "…";
}
