import { getLogger } from '../core/logger.js';

const log = getLogger();

interface DocumentExtractionResult {
  markdown: string;
  metadata: { title?: string; pages?: number; format: string };
}

export async function extractDocument(
  source: { type: 'pdf'; buffer: Buffer } | { type: 'html'; content: string },
): Promise<DocumentExtractionResult> {
  if (source.type === 'pdf') {
    return extractPdf(source.buffer);
  }
  return extractHtml(source.content);
}

async function extractPdf(buffer: Buffer): Promise<DocumentExtractionResult> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo();
    await parser.destroy();
    return {
      markdown: textResult.text,
      metadata: {
        title: infoResult.info?.Title ?? undefined,
        pages: infoResult.total,
        format: 'pdf',
      },
    };
  } catch (err) {
    log.warn({ err }, 'PDF extraction failed');
    return {
      markdown: '',
      metadata: { format: 'pdf' },
    };
  }
}

function extractHtml(html: string): DocumentExtractionResult {
  // Simple HTML -> markdown conversion preserving structure
  let md = html;
  // Remove scripts and styles
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Convert headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n');
  // Convert links
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  // Convert paragraphs and line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<p(?:\s[^>]*)?>(?!re>)/gi, '');
  // Convert lists
  md = md.replace(/<li[^>]*>/gi, '- ');
  md = md.replace(/<\/li>/gi, '\n');
  // Convert code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n');
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // Decode common entities
  md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace
  md = md.replace(/\n{3,}/g, '\n\n').trim();

  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return {
    markdown: md,
    metadata: {
      title: titleMatch?.[1] ?? undefined,
      format: 'html',
    },
  };
}
