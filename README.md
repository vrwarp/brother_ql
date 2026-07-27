# brother-ql-webusb

Print to Brother QL and P-touch label printers **directly from a web app**, using
[WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) — no driver,
no print spooler, no native helper application.

This is a TypeScript port of the [`brother_ql`](./PYTHON.md) Python package, which
remains in this repository as the reference implementation and as the generator for
the byte-exact golden test fixtures.

> 🚧 **Work in progress.** This README is filled in as the port lands; see
> [CHANGELOG.md](./CHANGELOG.md) for progress.

## License

GPL-3.0-or-later, inherited from the upstream Python package by Philipp Klaus.
