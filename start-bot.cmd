@echo off
setlocal
set "NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_BIN%" set "NODE_BIN=node"

set "HTTPS_PROXY=http://127.0.0.1:10801"
set "HTTP_PROXY=http://127.0.0.1:10801"

pushd "%~dp0"
"%NODE_BIN%" --use-env-proxy "%~dp0bot.mjs"
set "BOT_EXIT_CODE=%ERRORLEVEL%"
popd

exit /b %BOT_EXIT_CODE%
