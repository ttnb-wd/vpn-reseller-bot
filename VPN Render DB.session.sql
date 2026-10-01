SELECT
  c."telegramId" AS "Telegram ID",
  c.username AS "Username",
  c."firstName" AS "Name",
  s.plan AS "Package",
  s.status AS "Status",
  s."durationMonths" AS "Months",
  s."dataLimitGb" AS "Data Limit (GB)",
  s."dataUsedGb" AS "Used (GB)",
  s."startedAt" AS "Start Date",
  s."expiresAt" AS "Expiry Date"
FROM customer c
LEFT JOIN subscription s
  ON s."customerId" = c.id
ORDER BY s."createdAt" DESC;