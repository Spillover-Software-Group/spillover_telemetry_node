// A URL's credentials, `scheme://user:secret@host`: the secret is replaced, the scheme, the user and
// the host are kept, so a line still says which service and account it was about. A connection string
// reaches a log by paths nobody chose (a library's warning, an error's message), so everything the
// logger writes goes through this.
const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*):[^\s@/]+@/gi;

export function redactCredentials(text) {
  return typeof text === "string"
    ? text.replace(CREDENTIALS_IN_URL, "$1:***@")
    : text;
}
