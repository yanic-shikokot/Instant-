# FieldInspect Pro

FieldInspect Pro is a Windows desktop application for creating, managing, previewing, and exporting professional field inspection reports.

## Current release

**v1.8.8**

- Offline-first inspection storage
- Account sign-in and account creation
- Cloud synchronization when connected
- Inspection history and Recently Deleted
- Photo evidence capture
- Live report preview
- PDF report export
- CSV export
- Windows desktop installer
- Automatic application updates

## Install

### Windows

Download the latest Windows installer from the [GitHub Releases](https://github.com/yanic-shikokot/Instant-/releases) page.

### WinGet

After the Microsoft WinGet submission is approved and merged:

```powershell
winget install YanicShikokot.FieldInspectPro
```

## Development

### Requirements

- Windows 10/11 for desktop testing
- Node.js 22
- Git

### Run locally

```powershell
npm install
npm run dev
```

The Vite development server runs on port 3000.

### Build the Windows installer

```powershell
npm run dist
```

The installer is written to the `release/` directory.

## Architecture

- **Renderer:** HTML/CSS/JavaScript bundled with Vite
- **Desktop shell:** Electron
- **Local storage:** IndexedDB with localStorage fallback/mirror
- **Cloud services:** Supabase
- **Reports:** jsPDF
- **Distribution:** GitHub Releases, electron-updater, and WinGet
- **Web deployment:** Netlify

## Configuration

Client-side Supabase configuration is provided through `public/auth-config.js`. Only Supabase publishable configuration belongs in the client.

Server-side credentials such as M-Pesa credentials and Supabase secret keys must remain in Supabase Edge Function secrets or other server-side secret storage. Never commit them to this repository.

## Documentation

Project setup notes are available in [docs/](docs/).

## Support

For bugs and feature requests, use the repository's [Issues](https://github.com/yanic-shikokot/Instant-/issues).

## License

FieldInspect Pro is proprietary software. The source repository is public for development and distribution purposes; copying, redistribution, resale, or creation of derivative commercial products is not granted unless explicitly authorized by the copyright holder.
