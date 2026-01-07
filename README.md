# VS Code: Better Git Line Blame

A simple VS Code extension that annotates the current line with git blame information.

It's like the [GitLens] line annotation feature, but faster.

## Install

Get [Better Git Line Blame](https://marketplace.visualstudio.com/items?itemName=mk12.better-git-line-blame) on the Visual Studio Marketplace.

## Features

- Displays line annotations in the same style as GitLens.
- Optionally shows blame information in the status bar.
- Caches blame data so annotations are instantaneous.
- On hover, shows the commit author, date, message, and SHA.
- Autolinks to issues and PRs on GitHub and GitLab.
- Includes a "Show diff" link using VS Code's built-in diff viewer.
- Supports multiple git repositories in the same workspace.
- Uses `git blame --incremental` to provide blame quickly and incrementally.
- Loads commit message lazily without blocking blame annotation rendering.
- Handles untracked files, unsaved edits, and git branch changes.

## Commands

- **Better Git Line Blame: Toggle Inline Annotations**
    - Toggle betterGitLineBlame.showInlineAnnotations in your user settings file.
- **Better Git Line Blame: Toggle Status Bar Item**
    - Toggle betterGitLineBlame.showStatusBarItem in your user settings file.
- **Better Git Line Blame: Show Commit**
    - Show the commit message in a separate editor. Same as clicking on the status bar item.
- **Better Git Line Blame: Show Commit (Plain Text)**
    - Like "Show Commit", but in plain text instead of rendering as Markdown.
- **Better Git Line Blame: Show Diff**
    - Show the blame's diff for the current file. Same as the "Show diff" link.
- **Better Git Line Blame: Reblame File**
    - Rerun git blame on the current file.
- **Better Git Line Blame: Clear Cache**
    - Clear all cached git blame data.

## Configuration

- **betterGitLineBlame.showInlineAnnotations** (default: true)
    - Show git blame information as inline annotations. Hover on the annotations to see more details.
- **betterGitLineBlame.showStatusBarItem** (default: false)
    - Show git blame information in the status bar. Click on the status bar item to see more details.
- **betterGitLineBlame.enableHoverMessages** (default: true)
    - Show commit details when hovering over inline annotations.
- **betterGitLineBlame.showAuthorAvatar** (default: true)
    - Show commit author avatars in hover messages. The avatars are fetched from Gravatar based on email address.
- **betterGitLineBlame.authorAvatarSize** (default: 16)
    - Size of commit author avatars in CSS px.
- **betterGitLineBlame.annotateWholeLine** (default: false)
    - Attach annotations to the entire line. This prevents flicker when deleting lines, but shows commit details when hovering anywhere on the line.
- **betterGitLineBlame.statusBarItemPriority** (default: 500)
    - Priority of the status bar item. Items are ordered from highest to lowest priority, left to right.
- **betterGitLineBlame.ignoreWhitespaceChanges** (default: true)
    - Ignore whitespace changes when blaming lines, i.e. pass the `-w` flag to git blame.
- **betterGitLineBlame.reblameOnSave** (default: false)
    - Run the "Reblame File" command automatically on save.
- **betterGitLineBlame.maxSummaryLength** (default: 50)
    - Maximum length of commit message summaries in line annotations. Summaries longer than this will be truncated with an ellipsis. Set to 0 for no limit.
- **workbench.colorCustomizations** > **betterGitLineBlame.foregroundColor**
    - Foreground color of the inline blame annotations.

## FAQ

### Do I need to reblame?

Only if you're seeing "Uncommited changes" on lines with no diff.

The extension keeps track of local edits, and reblames on git HEAD changes, so you don't normally need to run the "Reblame File" command or use the betterGitLineBlame.reblameOnSave configuration. However, if you change a line and then later undo it, the annotation will still be "Uncomitted changes". If you want to see the original commit, you need to reblame.

### Why do annotations flicker when I delete or join lines?

By default, the extension attaches annotations to the end of the line. When you use VS Code's "Delete Line" or "Join Lines" commands, the annotation might briefly appear in the middle of a line, shifting the rest of the line to the right, before correcting itself. This is usually more noticeable when using Remote Development.

If this bothers you, you can enable the `betterGitLineBlame.annotateWholeLine` configuration property. This makes the annotations use [`isWholeLine: true`](https://code.visualstudio.com/api/references/vscode-api#DecorationRenderOptions.isWholeLine), ensuring they never appear in the middle of a line. The downside is that commit information will show when you hover anywhere on the line, not just when you hover on the blame annotation. In particular, it will get combined with hover messages provided by other extensions, such as type information and documentation.

## Alternatives

The alternative I'm competing with is [GitLens]. I find it too bloated, and dislike how it pushes paid features.

Someone else had the exact same idea with [carlthome/vscode-git-line-blame](https://github.com/carlthome/vscode-git-line-blame). However, as of March 2024, that extension is much simpler: it spawns a git process every time the text cursor moves.

## License

© 2024 Mitchell Kember

VS Code Git Line Blame is available under the MIT License; see [LICENSE](LICENSE.md) for details.

[GitLens]: https://gitlens.amod.io
