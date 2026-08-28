import bcrypt from 'bcryptjs'
import { prisma } from '@/config/prisma'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '@/lib/jwt'
import {
  ConflictError,
  UnauthorizedError,
  NotFoundError,
} from '@/lib/errors'
import { env } from '@/config/env'
import type { RegisterDtoType, LoginDtoType } from './auth.dto'

export class AuthService {
  // ─── Register ───────────────────────────────────────────────────────
  async register(dto: RegisterDtoType) {
    const exists = await prisma.user.findUnique({ where: { email: dto.email } })
    if (exists) throw new ConflictError('Email already registered')

    const rounds = parseInt(env.BCRYPT_ROUNDS, 10)
    const passwordHash = await bcrypt.hash(dto.password, rounds)

    const user = await prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role as 'MEDICO' | 'ADMIN',
        ...(dto.role === 'MEDICO' && {
          medico: {
            create: {
              cedulaProfesional: dto.cedulaProfesional,
              especialidad: dto.especialidad,
              hospital: dto.hospital,
            },
          },
        }),
      },
      include: { medico: true },
    })

    const tokens = this.generateTokens(user.id, user.email, user.role)
    await this.storeRefreshToken(user.id, tokens.refreshToken)

    return { user: this.sanitizeUser(user), ...tokens }
  }

  // ─── Login ──────────────────────────────────────────────────────────
  async login(dto: LoginDtoType) {
    const user = await prisma.user.findUnique({
      where: { email: dto.email },
      include: { medico: true },
    })
    if (!user) throw new UnauthorizedError('Invalid credentials')
    if (!user.isActive) throw new UnauthorizedError('Account disabled')

    const valid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!valid) throw new UnauthorizedError('Invalid credentials')

    const tokens = this.generateTokens(user.id, user.email, user.role)
    await this.storeRefreshToken(user.id, tokens.refreshToken)

    return { user: this.sanitizeUser(user), ...tokens }
  }

  // ─── Refresh ────────────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    const payload = verifyRefreshToken(refreshToken)

    const stored = await prisma.refreshToken.findFirst({
      where: { token: refreshToken, userId: payload.sub },
    })
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token invalid or expired')
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user || !user.isActive) throw new UnauthorizedError('User not found')

    // Rotate: delete old, issue new
    await prisma.refreshToken.delete({ where: { id: stored.id } })
    const tokens = this.generateTokens(user.id, user.email, user.role)
    await this.storeRefreshToken(user.id, tokens.refreshToken)

    return tokens
  }

  // ─── Logout ─────────────────────────────────────────────────────────
  async logout(refreshToken: string) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } })
  }

  // ─── Me ─────────────────────────────────────────────────────────────
  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { medico: true },
    })
    if (!user) throw new NotFoundError('User')
    return this.sanitizeUser(user)
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  private generateTokens(userId: string, email: string, role: string) {
    const accessToken  = signAccessToken({ sub: userId, email, role })
    const refreshToken = signRefreshToken(userId)
    return { accessToken, refreshToken }
  }

  private async storeRefreshToken(userId: string, token: string) {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)
    await prisma.refreshToken.create({ data: { userId, token, expiresAt } })
  }

  private sanitizeUser(user: { id: string; email: string; firstName: string; lastName: string; role: string; isActive: boolean; createdAt: Date; medico?: { id: string; especialidad: string | null; hospital: string | null } | null }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      medico: user.medico ?? undefined,
    }
  }
}
