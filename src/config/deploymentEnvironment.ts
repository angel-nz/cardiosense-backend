export interface DeploymentEnvironmentIssue {
  field: 'FRONTEND_URL' | 'AI_SERVICE_URL' | 'AI_SERVICE_KEY'
  message: string
}

const KNOWN_DEVELOPMENT_AI_KEYS = new Set([
  'internal-dev-key',
  'internal-dev-key-change-in-prod',
])

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])

function parseHttpsUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null
    if (parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return LOCAL_HOSTS.has(normalized) || normalized.endsWith('.localhost')
}

function isCanonicalFrontendOrigin(raw: string, parsed: URL): boolean {
  // Browser Origin values are scheme + host + optional port only. Requiring
  // exact equality to URL.origin also rejects trailing slash, path, query,
  // hash and credentials, keeping CORS configuration canonical.
  return raw === parsed.origin
}

// DEPLOY-BACKEND-PREP-FIX-1 — local development intentionally retains its
// current defaults, but production fails closed unless public endpoints are
// explicit, syntactically valid HTTPS URLs and the AI key is not a known
// development placeholder. Messages never include configured secret values.
export function validateProductionDeploymentEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): DeploymentEnvironmentIssue[] {
  if (source.NODE_ENV !== 'production') return []

  const issues: DeploymentEnvironmentIssue[] = []
  const frontendUrl = source.FRONTEND_URL?.trim()
  const aiServiceUrl = source.AI_SERVICE_URL?.trim()
  const aiServiceKey = source.AI_SERVICE_KEY?.trim()

  if (!frontendUrl) {
    issues.push({ field: 'FRONTEND_URL', message: 'must be explicitly configured in production' })
  } else {
    const parsed = parseHttpsUrl(frontendUrl)
    if (!parsed) {
      issues.push({ field: 'FRONTEND_URL', message: 'must be a valid absolute HTTPS origin in production' })
    } else if (isLocalHost(parsed.hostname)) {
      issues.push({ field: 'FRONTEND_URL', message: 'must not use a local development URL in production' })
    } else if (!isCanonicalFrontendOrigin(frontendUrl, parsed)) {
      issues.push({ field: 'FRONTEND_URL', message: 'must be an origin-only HTTPS value without path, query, hash, credentials, or trailing slash' })
    }
  }

  if (!aiServiceUrl) {
    issues.push({ field: 'AI_SERVICE_URL', message: 'must be explicitly configured in production' })
  } else {
    const parsed = parseHttpsUrl(aiServiceUrl)
    if (!parsed) {
      issues.push({ field: 'AI_SERVICE_URL', message: 'must be a valid absolute HTTPS URL in production' })
    } else if (isLocalHost(parsed.hostname)) {
      issues.push({ field: 'AI_SERVICE_URL', message: 'must not use a local development URL in production' })
    }
  }

  if (!aiServiceKey) {
    issues.push({ field: 'AI_SERVICE_KEY', message: 'must be explicitly configured in production' })
  } else if (KNOWN_DEVELOPMENT_AI_KEYS.has(aiServiceKey)) {
    issues.push({ field: 'AI_SERVICE_KEY', message: 'must not use a known development placeholder in production' })
  }

  return issues
}
