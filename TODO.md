+ work for file already open on startup
    x onDidChangeActiveTextEditor?
    + use window.visibleTextEditors instead of queuing
+ skip update if selections are in same lines (or just do 1 line?)
+ provide commit on hover
+ show diff of file
x figure out why onDidChangeTextEditorSelection fires constantly
    x log itself trigerred it on the log window, I think
+ work when opening split
    + changed map path->range to editor->range
+ work when opening new file
    + need to do it after blame is loaded
+ handle Not Commited Yet / sha=0
x blame multiple files at once
+ listen for git events (commit, change branch, etc.)
     + check if HEAD has changed, then redo blames
     + reblame all on demand after clearing, not just current
x handle unsaved/saved gaps not in the blame
    x no "uncommitted changes" for line when adding blank line at end of line
    x ... adding blank line at beginning of line
    x ... deleting blank line at end of line
    x ... deleting blank line at beginning of line
    x too hard
+ queue changes while loading
+ show "Loading blame"
+ commands to reblame
- evict cache of files when too large
