/**
 * Minimal PDF 1.4 writer: one page per sheet at its exact physical size, each page a single Flate-compressed
 * image. Printing at 100% therefore gives exact millimetres. Pure.
 */
import { zlibSync } from 'fflate';
import { isGreyscale, type RasterImage } from './raster';

interface PdfPage {
  widthPt: number;
  heightPt: number;
  imgW: number;
  imgH: number;
  grey: boolean;
  data: Uint8Array;
}

const PT_PER_MM = 72 / 25.4;
const enc = new TextEncoder();

function num(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

export class PdfBuilder {
  private pages: PdfPage[] = [];

  constructor(private title = 'Print sheets') {}

  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * Add a page of `widthMm` x `heightMm` showing `img` stretched over the whole page. The image is compressed
   * immediately so callers can drop the bitmap. Greyscale images are stored as one channel.
   */
  addImagePage(img: RasterImage, widthMm: number, heightMm: number, opts: { grey?: boolean; level?: number } = {}): void {
    const grey = opts.grey ?? isGreyscale(img);
    const n = img.width * img.height;
    const raw = new Uint8Array(n * (grey ? 1 : 3));
    const d = img.data;
    if (grey) for (let i = 0; i < n; i++) raw[i] = d[i * 4];
    else for (let i = 0, j = 0; i < n; i++, j += 3) {
      raw[j] = d[i * 4];
      raw[j + 1] = d[i * 4 + 1];
      raw[j + 2] = d[i * 4 + 2];
    }
    this.pages.push({
      widthPt: widthMm * PT_PER_MM,
      heightPt: heightMm * PT_PER_MM,
      imgW: img.width,
      imgH: img.height,
      grey,
      data: zlibSync(raw, { level: (opts.level ?? 6) as 6 }),
    });
  }

  finish(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let pos = 0;
    const push = (c: Uint8Array | string) => {
      const b = typeof c === 'string' ? enc.encode(c) : c;
      chunks.push(b);
      pos += b.length;
    };
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const objCount = 3 + this.pages.length * 3;
    const begin = (id: number) => {
      offsets[id] = pos;
      push(`${id} 0 obj\n`);
    };
    const end = () => push('endobj\n');
    // 1 catalog, 2 pages tree, 3 info, then per page: page, content, image.
    begin(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\n');
    end();
    begin(2);
    const kids = this.pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
    push(`<< /Type /Pages /Count ${this.pages.length} /Kids [${kids}] >>\n`);
    end();
    begin(3);
    push(`<< /Title (${this.title.replace(/[()\\]/g, '')}) /Producer (PixelArtify print) >>\n`);
    end();
    this.pages.forEach((p, i) => {
      const pageId = 4 + i * 3;
      const contentId = pageId + 1;
      const imageId = pageId + 2;
      begin(pageId);
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.widthPt)} ${num(p.heightPt)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> /ProcSet [/PDF /Image${p.grey ? 'B' : 'C'}] >> /Contents ${contentId} 0 R >>\n`,
      );
      end();
      const content = `q ${num(p.widthPt)} 0 0 ${num(p.heightPt)} 0 0 cm /Im0 Do Q\n`;
      begin(contentId);
      push(`<< /Length ${content.length} >>\nstream\n${content}endstream\n`);
      end();
      begin(imageId);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${p.imgW} /Height ${p.imgH} /ColorSpace /${p.grey ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode /Length ${p.data.length} >>\nstream\n`,
      );
      push(p.data);
      push('\nendstream\n');
      end();
    });
    const xrefAt = pos;
    push(`xref\n0 ${objCount + 1}\n`);
    push('0000000000 65535 f \n');
    for (let id = 1; id <= objCount; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    const out = new Uint8Array(pos);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
