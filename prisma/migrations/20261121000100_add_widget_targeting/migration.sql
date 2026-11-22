-- Preserve existing widget visibility with ALL and empty selections.
ALTER TABLE "Widget"
  ADD COLUMN "targetingMode" TEXT NOT NULL DEFAULT 'ALL',
  ADD COLUMN "targetProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "targetCollectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
