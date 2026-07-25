ALTER TABLE "runbook_chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(1024);--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "sources" jsonb DEFAULT '[]'::jsonb NOT NULL;