# Сборка под Android

Для сборки под Android нужны две вещи, которых нет в самом Go, и ещё одна —
чтобы поставить результат на телефон. Эта страница лежит внутри расширения,
поэтому открывается и без интернета; сеть нужна только на два скачивания.

| Что | Зачем | Нужна сеть |
|---|---|---|
| **fyne CLI** | упаковывает Go-код в `.apk` | один раз, для установки |
| **Android NDK** | C-компилятор, который вызывает сборка под Android | один раз, скачать (~1 ГБ) |
| adb (platform-tools) | копирует `.apk` на телефон; необязательно | один раз, скачать |

Когда оба на месте, **`GoForms: Build for Android (APK)`** работает полностью
офлайн. Идентификатор, имя, версия и иконка приложения берутся из
`FyneApp.toml` в проекте.

---

## 1. fyne CLI

Это программа на Go, ставится штатной командой Go:

```
go install fyne.io/tools/cmd/fyne@latest
```

Она кладёт `fyne` (`fyne.exe` в Windows) в bin-каталог Go:

- Linux / macOS: `~/go/bin/fyne`
- Windows: `C:\Users\<вы>\go\bin\fyne.exe`

(`go env GOPATH` печатает каталог; исполняемый файл — в его `bin`.)

Расширение само смотрит туда, больше ничего не требуется. Чтобы вызывать
`fyne` и из терминала, добавьте этот каталог в `PATH` — см.
[Добавление в PATH](#добавление-в-path) ниже — либо укажите путь к файлу в
настройке `goforms.fynePath` (`GoForms: Set fyne CLI Path...`).

Проверка: `fyne version` печатает `fyne cli version: v1.x`.

**Машина без интернета?** Выполните `go install` на любой машине с Go и
сетью и скопируйте один файл `fyne` / `fyne.exe`. Зависимостей у него нет.

---

## 2. Android NDK

Скачайте **Android NDK (Side by side)** с
<https://developer.android.com/ndk/downloads> — обычный `.zip` под вашу ОС,
*не* Android Studio. Подходит любая версия от r25; проверено на r27.

### Куда положить

Распакуйте архив. Внутри одна папка вида `android-ndk-r27d`. Переместите её
в одно из мест, где ищет расширение:

**Linux / macOS**

```
~/Android/android-ndk-r27d        <- рекомендуется
~/android-ndk-r27d
/opt/android-ndk-r27d
```

**Windows**

```
C:\Users\<вы>\Android\android-ndk-r27d    <- рекомендуется
C:\android-ndk-r27d
C:\Android\android-ndk-r27d
```

Если установлена Android Studio, NDK можно поставить через её SDK Manager
(*SDK Tools* > *NDK (Side by side)*); он окажется в `<SDK>/ndk/<версия>/`,
где расширение тоже ищет. `<SDK>` — это тот путь, который вы указали Android
Studio при установке; по умолчанию `~/Android/Sdk` в Linux,
`~/Library/Android/sdk` в macOS и `%LOCALAPPDATA%\Android\Sdk` в Windows.
Кроме них расширение смотрит в `C:\Android\Sdk`, `/opt/android-sdk` и
`/usr/lib/android-sdk`. Если SDK лежит где-то ещё — задайте `ANDROID_HOME`.

Расширение берёт самую новую найденную версию. Если NDK лежит в другом
месте — укажите его в `goforms.androidNdkPath`
(`GoForms: Set Android NDK Path...`) или через переменную окружения ниже.

### Как сообщить о нём терминалу

Расширению это не нужно, а вот `fyne package`, запущенному руками, и задаче
`GoForms: package (android/arm64)` из `.vscode/tasks.json` — нужно.
Переменная называется `ANDROID_NDK_HOME` и указывает на распакованную папку.

**Linux / macOS** — добавьте в `~/.bashrc`, `~/.zshrc` или `~/.profile`:

```sh
export ANDROID_NDK_HOME="$HOME/Android/android-ndk-r27d"
```

и откройте новый терминал (или `source ~/.bashrc`).

**Windows** — PowerShell, один раз, от своего пользователя (админ не нужен):

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_NDK_HOME", "$env:USERPROFILE\Android\android-ndk-r27d", "User")
```

либо *Параметры > Система > О системе > Дополнительные параметры системы >
Переменные среды > Переменные пользователя > Создать*. После этого откройте
новый терминал; VS Code тоже надо перезапустить, чтобы он увидел переменную.

### Проверка

Папка правильная, если в ней есть `source.properties` и
`toolchains\llvm\prebuilt\`. **`GoForms: Check Setup`** показывает, что
расширение нашло и где искало.

---

## 3. adb — установка на телефон

`adb` входит в *platform-tools*:
<https://developer.android.com/tools/releases/platform-tools>. Распакуйте
архив куда угодно и добавьте папку в `PATH` (ниже), либо положите её в
`<SDK>/platform-tools` — там расширение тоже смотрит. В Debian/Ubuntu
достаточно `sudo apt install adb`.

На телефоне: *Настройки > О телефоне*, семь раз нажать *Номер сборки*, затем
*Для разработчиков > Отладка по USB*. Подключите по USB и подтвердите запрос
на телефоне; `adb devices` должен его показать.

**`GoForms: Install APK on Connected Device`** после этого выполняет
`adb install -r` для самого свежего APK в `build/android/`. Без adb — просто
скопируйте `.apk` на телефон любым способом и откройте его там; в первый
раз телефон попросит разрешить установку из этого источника.

---

## Добавление в PATH

`PATH` — список папок, в которых терминал ищет команды. Добавьте папку —
и всё, что в ней, станет командой.

**Linux / macOS** — в `~/.bashrc` или `~/.zshrc`:

```sh
export PATH="$PATH:$HOME/go/bin:$HOME/Android/platform-tools"
```

**Windows** — PowerShell, от своего пользователя:

```powershell
$p = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$p;$env:USERPROFILE\go\bin;$env:USERPROFILE\Android\platform-tools", "User")
```

либо через *Переменные среды > Переменные пользователя > Path > Изменить >
Создать*. Уже открытые терминалы и окна VS Code сохраняют старый `PATH` —
откройте новые.

---

## Сборка

- **`GoForms: Build for Android (APK)`** — упаковывает
  `goforms.android.target` (по умолчанию `android/arm64`, это все телефоны
  примерно с 2015 года) в `build/android/<имя>.apk`.
- То же самое из терминала, из папки проекта:

  ```
  fyne package --os android/arm64
  ```

  С `--os android` соберутся все четыре архитектуры в один APK — вчетверо
  больше и дольше.

- Первая сборка компилирует C-часть Fyne через NDK, это несколько минут;
  дальше всё кэшируется и идёт быстро.
- **Release**-сборка для Play Store требует ещё ключ подписи:
  `fyne release --os android --keyStore ... --keyName ...`. Здесь собирается
  debug-сборка, которая ставится напрямую на любой телефон.

## Если не собирается

- *`fyne` not found* — установите его (шаг 1) или задайте `goforms.fynePath`.
- *NDK not found* — шаг 2; `GoForms: Check Setup` перечисляет, где искали.
- *`clang: not found`, `ndk-bundle`, `toolchains`* — указанная папка не
  корень NDK; в корне должен быть `toolchains/llvm/prebuilt`.
- *`cannot find module` / `dial tcp`* — Go попытался скачать модуль. Один раз
  при наличии сети выполните `go mod download`; дальше все сборки локальные.
- *`INSTALL_FAILED_UPDATE_INCOMPATIBLE`* при установке — на телефоне уже
  стоит приложение с тем же id, но другой подписью. Удалите его.
