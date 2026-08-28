import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV:          z.enum(['development', 'production', 'test']).default('development'),
  PORT:              z.string().default('3001'),
  DATABASE_URL:      z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET:        z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET:z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN:    z.string().default('1h'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  FRONTEND_URL:      z.string().default('http://localhost:5173'),
  AI_SERVICE_URL:    z.string().default('http://localhost:8000'),
  AI_SERVICE_KEY:    z.string().default('internal-dev-key'),
  BCRYPT_ROUNDS:     z.string().default('12'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
