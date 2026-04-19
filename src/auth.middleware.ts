import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './utils/jwt';

export interface AuthRequest extends Request {
  user: any;
}

export function requireAuth(req: any, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
}
