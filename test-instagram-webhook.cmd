@echo off
setlocal
set "NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_BIN%" set "NODE_BIN=node"

pushd "%~dp0"
"%NODE_BIN%" "%~dp0tools\check-instagram-webhook.mjs"
set "TEST_EXIT_CODE=%ERRORLEVEL%"
popd

exit /b %TEST_EXIT_CODE%
