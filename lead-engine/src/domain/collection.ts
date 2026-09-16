import crypto from 'node:crypto';
import { db } from '../db/store.js';
import { SourceService } from './sources.js';
import { CrawlRun, EvidenceArtifact } from '../types/index.js';

export interface RawCollectionItem {
  url: string;
  title?: string;
  organization?: string;
  content: string;
  contentType?: string;
}

export class CollectionService {
  static runCrawl(
    sourceId: string,
    itemsToCollect: RawCollectionItem[]
  ): { crawlRun: CrawlRun; artifacts: EvidenceArtifact[] } {
    const sourceCheck = SourceService.checkCanRun(sourceId);
    if (!sourceCheck.canRun) {
      throw new Error(`Collection blocked: ${sourceCheck.reason}`);
    }

    const source = db.sources.get(sourceId)!;

    const crawlRun: CrawlRun = {
      id: crypto.randomUUID(),
      sourceId,
      workspaceId: source.workspaceId,
      status: 'running',
      itemCount: 0,
      bytesDownloaded: 0,
      startedAt: new Date().toISOString()
    };
    db.crawlRuns.set(crawlRun.id, crawlRun);

    const artifacts: EvidenceArtifact[] = [];

    for (const item of itemsToCollect) {
      if (crawlRun.itemCount >= source.policy.dailyBudget) {
        crawlRun.status = 'stopped';
        crawlRun.stopReason = 'Daily collection budget reached';
        break;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(item.url);
      } catch {
        continue;
      }

      if (!source.policy.allowedDomains.includes(parsedUrl.hostname)) {
        continue;
      }

      const contentHash = crypto.createHash('sha256').update(item.content).digest('hex');

      const artifact: EvidenceArtifact = {
        id: crypto.randomUUID(),
        workspaceId: source.workspaceId,
        sourceId,
        canonicalUrl: this.canonicalizeUrl(item.url),
        contentHash,
        contentType: item.contentType || 'text/html',
        rawContent: item.content,
        extractedTitle: item.title,
        extractedOrganization: item.organization,
        fetchedAt: new Date().toISOString()
      };

      db.evidenceArtifacts.set(artifact.id, artifact);
      artifacts.push(artifact);

      crawlRun.itemCount += 1;
      crawlRun.bytesDownloaded += Buffer.byteLength(item.content, 'utf8');
    }

    if (crawlRun.status === 'running') {
      crawlRun.status = 'completed';
    }
    crawlRun.endedAt = new Date().toISOString();
    db.crawlRuns.set(crawlRun.id, crawlRun);

    return { crawlRun, artifacts };
  }

  static canonicalizeUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.delete('utm_source');
      parsed.searchParams.delete('utm_medium');
      parsed.searchParams.delete('utm_campaign');
      parsed.searchParams.delete('utm_term');
      parsed.searchParams.delete('utm_content');
      parsed.searchParams.delete('ref');
      parsed.searchParams.delete('fbclid');
      parsed.searchParams.delete('gclid');

      if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      return parsed.toString();
    } catch {
      return rawUrl.trim();
    }
  }
}
