-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "activationStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "schedule" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "inputFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "invocationMode" TEXT NOT NULL DEFAULT 'on_demand';

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "inferenceStatus" TEXT NOT NULL DEFAULT 'confident',
ADD COLUMN     "inputFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "invocationMode" TEXT NOT NULL DEFAULT 'on_demand',
ADD COLUMN     "notes" TEXT;
