import type { Request, Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import { AuthService } from './auth.service'

const svc = new AuthService()

export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.register(req.body)
    res.status(201).json(result)
  } catch (err) { next(err) }
}

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.login(req.body)
    res.json(result)
  } catch (err) { next(err) }
}

export const refresh = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tokens = await svc.refresh(req.body.refreshToken)
    res.json(tokens)
  } catch (err) { next(err) }
}

export const logout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await svc.logout(req.body.refreshToken ?? '')
    res.json({ success: true })
  } catch (err) { next(err) }
}

export const me = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await svc.me(req.user.sub)
    res.json(user)
  } catch (err) { next(err) }
}
