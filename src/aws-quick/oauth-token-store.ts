export interface RefreshedOAuthTokens {
  clientId: string;
  wsHost: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

type TokenSink = (tokens: RefreshedOAuthTokens) => void | Promise<void>;
const sinks = new Set<TokenSink>();

export function registerOAuthTokenSink(sink: TokenSink): () => void {
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

export async function persistRefreshedOAuthTokens(tokens: RefreshedOAuthTokens): Promise<void> {
  await Promise.all([...sinks].map((sink) => sink(tokens)));
}
