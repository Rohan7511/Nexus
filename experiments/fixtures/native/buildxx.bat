@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set INC=%LOCALAPPDATA%\node-gyp\Cache\25.1.0\include\node
set NLIB=%LOCALAPPDATA%\node-gyp\Cache\25.1.0\x64\node.lib
cl /nologo /LD /O2 /std:c++20 /Zc:__cplusplus /EHsc /DNODE_GYP_MODULE_NAME=raw /I "%INC%" %1 /Fe%2 /link /DLL "%NLIB%"
