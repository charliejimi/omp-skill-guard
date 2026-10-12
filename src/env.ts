// The environment omp-safe gives omp: empty, plus the variables omp needs to run and the ones the
// user passes on purpose. Code omp loads runs in omp's process and can read every variable it has.

/** Variables omp needs to run; everything else is dropped unless the user passes it with `passEnv`. */
export const DEFAULT_PASS_ENV: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"COLORTERM",
	"TERM_PROGRAM",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TZ",
	"TMPDIR",
	"NO_COLOR",
	"FORCE_COLOR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
];

/** An empty environment plus the allowlisted names that are set. */
export function childEnv(source: Readonly<Record<string, string | undefined>>, pass: readonly string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of new Set([...DEFAULT_PASS_ENV, ...pass])) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}
