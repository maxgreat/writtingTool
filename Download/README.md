# Download Writing Tool

Choose your system. Each link gets the newest build of the app.

| System | File |
| --- | --- |
| [Windows](#windows) 10 and 11, 64-bit | [Writing-Tool-windows-x64-setup.exe](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-windows-x64-setup.exe) |
| [macOS](#macos), Apple silicon and Intel | [Writing-Tool-macos-universal.dmg](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-macos-universal.dmg) |
| [Linux](#linux), x86_64 | [AppImage](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-linux-x86_64.AppImage), [.deb](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-linux-amd64.deb) or [.rpm](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-linux-x86_64.rpm) |
| [Android](#android), 64-bit ARM phones | [Writing-Tool-android-arm64.apk](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-android-arm64.apk) |

The apps aren't code-signed yet, so Windows and macOS warn you the first time you open the app. The steps below say what to choose.

## Windows

**[Download the setup file (.exe)](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-windows-x64-setup.exe)** for Windows 10 and 11, 64-bit.

Run the setup file. If SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**. It installs for your user account only, without admin rights.

## macOS

**[Download the disk image (.dmg)](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-macos-universal.dmg)** for Apple silicon and Intel Macs.

Open the disk image and drag Writing Tool to Applications. The first time you open the app, macOS says it can't verify it: open **System Settings → Privacy & Security** and choose **Open Anyway**.

## Linux

**[Download the AppImage](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-linux-x86_64.AppImage)** for x86_64, which runs on most distributions. Make it executable, then run it:

```sh
chmod +x Writing-Tool-linux-x86_64.AppImage
./Writing-Tool-linux-x86_64.AppImage
```

Or install a package:

- Debian, Ubuntu: **[the .deb package](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-linux-amd64.deb)**, then `sudo apt install ./Writing-Tool-linux-amd64.deb`
- Fedora, openSUSE: **[the .rpm package](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-linux-x86_64.rpm)**, then `sudo dnf install ./Writing-Tool-linux-x86_64.rpm` (on openSUSE, `sudo zypper install --allow-unsigned-rpm ./Writing-Tool-linux-x86_64.rpm`, as the package isn't signed yet)

The app needs WebKitGTK 4.1, which current distributions have.

## Android

**[Download the APK](https://github.com/maxgreat/writtingTool/releases/latest/download/Writing-Tool-android-arm64.apk)** for 64-bit ARM phones, which is nearly every phone from the last several years.

Download it on the phone and open it. When asked, allow your browser to install apps. Later builds install over it and keep your projects.

## Earlier builds

[Releases](https://github.com/maxgreat/writtingTool/releases) has the 10 newest builds, each with the changes it brought. The [website](https://maxgreat.github.io/writtingTool/) has these downloads too, with screenshots.
