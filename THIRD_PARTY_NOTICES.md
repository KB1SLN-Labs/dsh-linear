# Third-party notices

This plugin, `@kb1slnlabs/dsh-linear`, is licensed under the MIT license in
`LICENSE` (Copyright (c) 2026 KB1SLN-Labs). This file records the third-party
material that informed or is reflected in its implementation.

## @deepseek-ai/dsh-mcp-client

The MCP parity tools in this plugin (`linear_mcp_*`) are a bridge to Linear's
hosted MCP server. That bridge is **informed by and includes closely related
implementation patterns** from `@deepseek-ai/dsh-mcp-client`, the DeepSeek
Harness MCP client bridge. In particular it mirrors that package's naming
contract for registering discovered MCP tools as harness tools, its handling of
advertised output schemas (unsupported vocabulary falls back to
annotation-only), its raw record result schema, and its use of the official
Model Context Protocol SDK's Streamable HTTP transport with uncached paginated
`tools/list` discovery.

- Package: `@deepseek-ai/dsh-mcp-client`
- Version: `0.1.5-rc.2`
- License: MIT (full text reproduced verbatim below)
- Copyright: (c) 2026 DeepSeek
- Repository: https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/mcp/mcp-client

The full MIT license text as shipped in that package's `LICENSE` file,
reproduced verbatim:

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
