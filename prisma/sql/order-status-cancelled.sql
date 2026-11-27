-- Adds CANCELLED to the OrderStatus enum for cancelled checkout requests.
-- Safe to re-run: every statement is idempotent.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
