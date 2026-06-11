Set-Location $PSScriptRoot\..
$tree = git write-tree
if (-not $tree) { exit 1 }
$sub = "commit-tree"
& git $sub $tree -m "Initial commit: Keyword Star Atlas MVP scaffold." | ForEach-Object {
  git update-ref refs/heads/master $_
}
git log -1 --oneline
