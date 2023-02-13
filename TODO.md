x Actually maybe should just use GitLens, has other features I need...
+ work for file already open on startup
    x onDidChangeActiveTextEditor?
    + use window.visibleTextEditors instead of queuing
- skip update if selections are in same lines (or just do 1 line?)
- handle unsaved/saved gaps not in the blame
- evict cache of files when too large
- blame multiple files at once
- listen for git events (commit, change branch, etc.)
- provide commit on hover
