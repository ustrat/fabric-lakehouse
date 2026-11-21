-- GENERATED from operational-api/registry/metrics.json by scripts/generate-registry-sql.js. Do not edit.
-- registryVersion=1 registryHash=0f955de45c809c38 model=product_reviews table=gold_product_review_summary
SELECT
    p.productId AS productId,
    p.name AS productName,
    p.categoryName AS categoryName,
    p.currentPrice AS currentPrice,
    CASE WHEN p.currentPrice >= 1000 THEN 'premium' ELSE 'standard' END AS priceBand,
    COUNT(r.id) AS reviewCount,
    COALESCE(SUM(r.stars), 0) AS sumStars,
    ROUND(COALESCE(SUM(r.stars), 0) / NULLIF(COUNT(r.id), 0), 2) AS avgStars,
    MAX(CAST(r.reviewDate AS DATE)) AS lastReviewDate,
    1 AS registryVersion,
    '0f955de45c809c38' AS registryHash,
    current_timestamp() AS refreshedAt
FROM SampleData p LEFT JOIN SampleData r ON r.productId = p.productId AND r.docType = 'review'
WHERE p.docType = 'product'
GROUP BY p.productId, p.name, p.categoryName, p.currentPrice, CASE WHEN p.currentPrice >= 1000 THEN 'premium' ELSE 'standard' END
