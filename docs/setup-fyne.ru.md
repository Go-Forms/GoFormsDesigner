# Утилита fyne (CLI)

`fyne` — консольная утилита проекта Fyne (`fyne.io/tools/cmd/fyne`).
GoForms Designer использует её для одного: упаковки APK под Android
(`fyne package --os android`). Для desktop и WebAssembly она не нужна.

## Установка

Это программа на Go, ставится самим Go:

```
go install fyne.io/tools/cmd/fyne@latest
```

Файл окажется в bin-каталоге Go — `~/go/bin/fyne` в Linux и macOS,
`C:\Users\<вы>\go\bin\fyne.exe` в Windows (`go env GOPATH` показывает
каталог). Расширение само смотрит туда.

Проверка: `fyne version`.

## Чтобы вызывать и из терминала

Добавьте bin-каталог Go в `PATH`:

- **Linux / macOS** — в `~/.bashrc` или `~/.zshrc`:
  `export PATH="$PATH:$HOME/go/bin"`, затем откройте новый терминал.
- **Windows** — PowerShell:
  `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\go\bin", "User")`,
  затем откройте новый терминал (и перезапустите VS Code).

## Лежит в другом месте?

Укажите файл расширению: `GoForms: Set fyne CLI Path...` или настройка
`goforms.fynePath`.

## Без интернета

Выполните `go install` на любой машине с Go и сетью и скопируйте один файл
`fyne` / `fyne.exe`. Зависимостей у него нет.

Самой сборке под Android нужен ещё Android NDK — см. инструкцию по Android
(`GoForms: Open Setup Guide` > Android).
