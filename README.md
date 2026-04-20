# Accounting GitHub Pages

Static GitHub Pages version of the accounting project.

## What This Version Does

- Keeps the same UI and accounting logic as the main project
- Starts from the same chart of accounts, opening balances, and journal data
- Runs fully in the browser with no ASP.NET backend
- Stores user changes in browser `localStorage`
- Works on GitHub Pages as a static site

## Data Storage

- Initial seed files:
  - `data/accounts.json`
  - `data/journals.json`
  - `data/opening-balances.json`
- Runtime edits after deployment:
  - browser `localStorage`

## Publish To GitHub Pages

1. Upload the contents of this folder to a GitHub repository.
2. In GitHub, open `Settings` -> `Pages`.
3. Set the source to deploy from the branch that contains these files.
4. Use the folder root as the published site.

## Notes

- This version is client-side only.
- Changes made by users are saved in their own browser, not back to the repository.
- `404.html` is included so the site is safe to publish directly on GitHub Pages.
