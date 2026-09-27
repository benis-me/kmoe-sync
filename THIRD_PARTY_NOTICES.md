# Third-party notices

## kmoeshelf

The Kmoe site adapter (`server/kmoe/*`: page and `data_book` parsing, login and download-link protocol) is ported and
adapted from [84xiaodu/kmoeshelf](https://github.com/84xiaodu/kmoeshelf).

```
MIT License

Copyright (c) 2026 84xiaodu

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

## Unicode CLDR / ICU (character folding table)

`server/metadata/chars.ts` holds a Traditional → Simplified Chinese character table generated with the ICU `Hant-Hans`
transliterator, i.e. from Unicode CLDR transform data. It is only used to compare titles and author names when matching
library folders to Bangumi subjects. (The short Japanese shinjitai list in the same file is original to this project.)

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2016-2025 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## References

Protocol notes (no code copied) from [holdjun/kmoe](https://github.com/holdjun/kmoe) and
[chrisis58/kmoe-manga-downloader](https://github.com/chrisis58/kmoe-manga-downloader), both MIT.

The Bangumi → Komga metadata feature is modelled on the behaviour of
[chu-shen/BangumiKomga](https://github.com/chu-shen/BangumiKomga). That project publishes no license, so none of its code
or data is included here; the feature is an independent implementation against the public Bangumi and Komga APIs.

Offline Bangumi data is downloaded at runtime from the [Bangumi Archive](https://github.com/bangumi/Archive) weekly dump and
is never bundled. The importer (`server/metadata/archive.ts`, `wiki.ts`) follows the dump format described in that README,
recognises the numeric platform / relation / staff-position codes documented in [bangumi/common](https://github.com/bangumi/common),
and parses infobox wiki text per the syntax described in [bangumi/wiki-syntax-spec](https://github.com/bangumi/wiki-syntax-spec).
None of these repositories publishes a license, so no code or data files from them are included; the parser and the few
code constants are written for this project.

## Bundled front-end libraries

UI primitives follow [shadcn/ui](https://ui.shadcn.com) (MIT) on [Radix UI](https://www.radix-ui.com) (MIT); icons are
[Lucide](https://lucide.dev) (ISC). The AI assistant renders Markdown with [react-markdown](https://github.com/remarkjs/react-markdown),
[remark-gfm](https://github.com/remarkjs/remark-gfm) and [remark-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) (all MIT).
The interface type is [Geist and Geist Mono](https://github.com/vercel/geist-font) (Copyright 2024 The Geist Project Authors,
[SIL Open Font License 1.1](https://openfontlicense.org)), bundled through [Fontsource](https://fontsource.org).
Their licenses ship with the packages in `node_modules`.
