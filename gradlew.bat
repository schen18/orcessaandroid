@rem
@rem Copyright 2015 the original author or authors.
@rem
@rem Gradle wrapper bootstrap for Windows.
@rem

@if "%DEBUG%"=="" @echo off
@rem Set local scope for the variables with windows NT shell
if "%OS%"=="Windows_NT" setlocal

set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.
@rem This is normally unused
set _SCRIPT=%~n0

set CLASSPATH=%DIRNAME%\gradle\wrapper\gradle-wrapper.jar

@rem Find java.exe
if defined JAVA_HOME goto findJavaFromJavaHome
set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if %ERRORLEVEL% equ 0 goto execute
echo. 1>&2
echo ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH. 1>&2
exit /b 1

:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%/bin/java.exe
if exist "%JAVA_EXE%" goto execute
echo. 1>&2
echo ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME% 1>&2
exit /b 1

:execute
if not exist "%CLASSPATH%" (
    echo. 1>&2
    echo ERROR: gradle/wrapper/gradle-wrapper.jar is not present. 1>&2
    echo        Open the project in Android Studio once to generate it, or run: 1>&2
    echo        gradle wrapper --gradle-version 8.11.1 1>&2
    exit /b 1
)

"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% ^
  -classpath "%CLASSPATH%" ^
  org.gradle.wrapper.GradleWrapperMain %*

if "%OS%"=="Windows_NT" endlocal
