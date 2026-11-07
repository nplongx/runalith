# WS2 review vectors: WS8 diagnostic envelope mapping

Status: REVIEW_FIXTURE_NOT_TRANSPORT_RATIFICATION.

WS8 candidate hashes: document 8e63787d7054aba3b4dd54cf2b692ca5b8a986e2667bc89bba0b3e831e2debae; example eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3; validator fc7cb33eca6f384a47c865bf8ce37a49e6aa277c2fe88385ddd375621ed51bf1.

WS2 acceptance invariants: known causes preserve exact pinned cause_code-to-domain_code pairs; projection is 29/29 unique with no missing/duplicate rows; future unknown cause is preserved verbatim only with domain_code null and receiver UNKNOWN/UNRESOLVED; outer message/producer/subject/correlation/causation/payload_digest remain separate; MCP error V1 remains {code,message}. No HTTP, retry, terminality, authorization or provider truth is inferred.

Reproduce: python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v1-test.py. The WS2-side oracle tests wrong valid pair, duplicate cause, missing cause and unknown future cause with non-null domain. It does not execute or certify WS8 runtime/mapping/digest/auth behavior; WS8 must add equivalent tests to its own successor.

Fixture SHA256 463e363c6b5688a5fbc137c7cf3cd4aa9e490b90cbce631eb1a09ac59c658807; validator SHA256 5c23d7faaf78c1008d59a9cdc678fe504b4cdf16b2f7f61f54d83f1aa0038dfa.
