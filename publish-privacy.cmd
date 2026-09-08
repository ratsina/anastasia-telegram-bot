@echo off
setlocal

set "NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

set "HTTP_PROXY=http://127.0.0.1:10801"
set "HTTPS_PROXY=http://127.0.0.1:10801"
set "NO_PROXY=localhost,127.0.0.1"

"%NODE_BIN%" --use-env-proxy "%~dp0tools\publish-privacy.mjs"

endlocal
