# Bundled Whisper Assets

Run `npm run prepare:whisper` before packaging the desktop app.

Expected layout:

```text
vendor/whisper/
├── whisper-cli            # or whisper-cli.exe on Windows
└── models/
    └── ggml-small.bin
```

The generated files are intentionally ignored by git because the model is large.
