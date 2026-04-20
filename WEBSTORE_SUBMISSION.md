# Chrome Web Store Submission Guide

This project must be submitted using the **compiled extension package** from `dist/`.
Do **not** upload the source project folder.

## Why this matters

The source manifest references development files (for Vite/CRX plugin), while Chrome Web Store
expects runtime-ready files only. Uploading the source package can cause errors like:

- `Could not load options page src/options/index.html`
- False "unused permissions" reports
- "No functionality" review failures

## Correct packaging steps

From project root:

```bash
npm install
npm run package:webstore
```

This will:

1. Build the extension (`dist/`)
2. Validate key files referenced by `dist/manifest.json`
3. Generate `webstore-package.zip` from the contents of `dist/`

Upload **`webstore-package.zip`** to Chrome Web Store.

## Quick pre-submit checklist

- [ ] `npm run package:webstore` succeeds
- [ ] Upload file is `webstore-package.zip` (not source zip)
- [ ] In local test (`chrome://extensions`), options page opens and side panel works
- [ ] Run at least one index action and one Q&A request successfully
