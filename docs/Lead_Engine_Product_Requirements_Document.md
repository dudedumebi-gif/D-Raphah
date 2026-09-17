Lead Engine Product Requirements Document

Multi Source Opportunity Discovery and Revenue Pipeline for AI and Business Systems Advisory

Decision summary  Build the Lead Engine as a compliant business development operating system. It will discover public business opportunities, qualify them against the advisory offer, support human reviewed outreach, and measure conversion to paid work. LinkedIn remains an important channel, but the product will not scrape LinkedIn or automate prohibited activity.

1 Executive Summary

The Lead Engine will help a solo entrepreneur build a repeatable pipeline for an AI and Business Systems Advisory side business. The application will collect opportunity signals from approved public sources, normalize them into a common record, remove duplicates, score fit and urgency, and place the strongest opportunities into a review queue. The user can then research the organization, prepare a relevant outreach approach, manage the commercial pipeline, and track revenue.

The first release is an internal single user product. It should prove that the opportunity discovery and conversion process can create qualified conversations and paid audits before the product is expanded into a software service. The system will support APIs, RSS feeds, sitemaps, public web pages, public documents, manual URLs, email forwards, and CSV imports. Every automated source must pass a source approval check that covers access permissions, terms, robots rules, collection purpose, allowed fields, rate limits, retention, and review cadence.

1.1 Product Decision

Build an internal first lead intelligence product before considering a commercial software service.

Use LinkedIn for profile authority, content, Service Page demand, relationship building, and manual opportunity capture.

Do not scrape LinkedIn, bypass access controls, automate account activity, or send mass messages.

Collect organization level business signals by default. Collect personal information only when the source and intended use have been approved.

Keep outreach human approved. The product may draft messages, but it may not send them automatically in the MVP.

1.2 Commercial Model

2 Product Context

2.1 Business Problem

A solo consulting venture cannot depend on irregular referrals or occasional high performing posts. Opportunity discovery is fragmented across LinkedIn, business websites, procurement notices, directories, event pages, job postings, public reports, and inbound messages. Reviewing these sources manually consumes time, produces inconsistent qualification decisions, and makes it difficult to connect business development activity to revenue.

Existing lead generation tools often emphasize contact harvesting and volume. That approach creates legal, platform, privacy, and reputation risk. The Lead Engine will instead identify evidence of a business problem, explain why the signal is relevant, and help the user choose a respectful route to a conversation.

2.2 Target Customer for the Advisory Business

The initial ideal customer profile is a Canadian founder led or owner managed service business with approximately 5 to 50 employees. Priority segments include accounting, bookkeeping, real estate, mortgage services, consulting, training, recruitment, home services, commercial services, and small technology companies.

2.3 Initial User

3 Product Vision and Principles

3.1 Product Vision

Create a daily operating system that turns permitted public business signals and relationship activity into qualified consulting opportunities, structured follow up, and measurable revenue.

3.2 Product Principles

4 Goals and Scope

4.1 Business Goals

4.2 Product Goals

Maintain one searchable opportunity inbox across all supported sources.

Show why each opportunity matches the ideal customer profile and offer ladder.

Detect duplicates and combine evidence from several sources into one organization record.

Support a complete path from discovered signal to revenue and referral.

Provide source level controls for frequency, rate, permitted data, retention, and suspension.

4.3 Non Goals for the MVP

5 Opportunity Model

5.1 Opportunity Types

5.2 Approved Source Categories

5.3 Opportunity Lifecycle

6 End to End User Experience

7 Functional Requirements

Priorities use P0 for MVP launch requirements, P1 for the first expansion, and P2 for later productization.

8 Web Collection Requirements

8.1 Source Approval Gate

8.2 Crawler Behaviour

Fetch robots.txt before the first crawl and refresh it on a configurable schedule.

Use a descriptive user agent and provide a contact URL or email where appropriate.

Crawl only the approved scheme, hostname, and path patterns. Reject redirects to unapproved domains.

Limit request rate and concurrency per domain. Apply exponential backoff for 429 and transient server errors.

Stop collection when a site requires authentication, presents a CAPTCHA, blocks the user agent, or changes its terms or technical controls.

Prefer feeds, APIs, sitemaps, conditional requests, and incremental updates over repeated full page retrieval.

Store the source URL, retrieval time, response status, content type, content hash, parser version, and policy decision.

Do not execute untrusted page scripts unless a source specific approval requires a browser renderer and the security review permits it.

Do not download executables or unsupported archives. Enforce file size, MIME type, and timeout limits.

8.3 Extraction and Provenance

8.4 Source Stop Conditions

9 LinkedIn Requirements

LinkedIn supports authority building, inbound demand, relationship development, and manual opportunity capture. The Lead Engine will respect the platform boundary and will not depend on unauthorized data collection.

10 Qualification and Intelligence

10.1 Opportunity Score

The total score is the weighted sum of the seven factors. Risk flags do not silently alter the score. They appear separately and may block qualification or outreach.

10.2 Default Thresholds

10.3 Artificial Intelligence Controls

11 Outreach and Conversion

11.1 Outreach Readiness Checklist

11.2 Draft Types

Contextual connection request

Referral introduction request

Response to an explicit service request or procurement notice

Website contact form response

Permission based business email

Discovery call agenda and follow up

Audit proposal and next step reminder

11.3 Pipeline Requirements

12 Data Model

13 Conceptual Architecture

14 Nonfunctional Requirements

15 Success Metrics

15.1 North Star Metric

Qualified opportunities reviewed that produce a substantive prospect conversation. This metric connects discovery quality to real commercial engagement and avoids rewarding raw lead volume.

15.2 Operating Economics

Until the business has produced at least CAD 1,000 in recurring monthly revenue, recurring software and infrastructure spend should remain below CAD 150 per month unless a documented experiment has a defined payback test. Labour time must also be tracked because a low cash cost can still conceal an inefficient workflow.

16 Release Plan

16.1 MVP Launch Acceptance

17 Risks and Mitigations

18 Decisions and Open Questions

19 Delivery Backlog

20 Compliance References

These sources inform the product guardrails. They are not a substitute for legal advice or a source specific terms review.

1 LinkedIn User Agreement

The agreement prohibits software, scripts, robots, crawlers, plugins, or other processes used to scrape or copy LinkedIn services and data. The product therefore blocks LinkedIn crawling and automated account activity.

https://www.linkedin.com/legal/user-agreement

2 Robots Exclusion Protocol RFC 9309

The crawler will implement the standardized robots.txt protocol and record the rule set used for each collection decision.

https://www.rfc-editor.org/rfc/rfc9309.html

3 CRTC Canada Anti Spam Legislation Frequently Asked Questions

Commercial electronic messages generally require consent, sender identification, and an unsubscribe mechanism. Outreach readiness records these elements where applicable.

https://crtc.gc.ca/eng/com500/faq500.htm

4 Office of the Privacy Commissioner of Canada Data Scraping Statement

Publicly accessible personal information remains subject to privacy and data protection laws. The product defaults to organization level signals and minimizes personal information.

https://www.priv.gc.ca/en/opc-news/speeches-and-statements/2024/js-dc_20241028/

5 Office of the Privacy Commissioner of Canada E Marketing Guidance

The guidance warns against address harvesting and explains organizational accountability for consent and third party marketing lists.

https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/canadas-anti-spam-legislation/casl-compliance-help-for-businesses/casl_guide/

21 Definition of Done

End of document