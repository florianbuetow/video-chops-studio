# =============================================================================
# Justfile Rules:
# 1. Use printf for colored or formatted output.
# 2. Add an empty @echo "" before and after every command block.
# 3. Keep help ordered by lifecycle, run/build, quality, then tests.
# 4. Composite recipes fail fast.
# 5. Every recipe ends with a clear success or failure status.
# =============================================================================

_default:
    @just help

check:
    @echo ""
    @if ! command -v node >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: node is not installed\033[0m\n"; \
        printf "  Install Node.js 24.0.0+: https://nodejs.org/\n"; \
        echo ""; \
        exit 1; \
    fi
    @node -e 'const required = "24.0.0".split(".").map(Number); const actual = process.versions.node.split(".").map(Number); for (let index = 0; index < required.length; index += 1) { if (actual[index] > required[index]) process.exit(0); if (actual[index] < required[index]) { console.error("\x1b[31m✗ Error: Node.js 24.0.0+ required, found " + process.versions.node + "\x1b[0m"); process.exit(1); } }'
    @printf "\033[32m✓ node is installed\033[0m\n"
    @node --version | sed 's/^/  /'
    @if ! command -v npm >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: npm is not installed\033[0m\n"; \
        printf "  npm ships with Node.js: https://nodejs.org/\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ npm is installed\033[0m\n"
    @for tool in ffmpeg ffprobe; do \
        if ! command -v "$tool" >/dev/null 2>&1; then \
            printf "\033[31m✗ Error: %s is not installed\033[0m\n" "$tool"; \
            printf "  Install FFmpeg and ensure both tools are on PATH.\n"; \
            exit 1; \
        fi; \
    done
    @printf "\033[32m✓ ffmpeg and ffprobe are installed\033[0m\n"
    @if ! command -v codespell >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: codespell is not installed\033[0m\n"; \
        printf "  Install with: brew install codespell\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ codespell is installed\033[0m\n"
    @if ! command -v semgrep >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: semgrep is not installed\033[0m\n"; \
        printf "  Install with: brew install semgrep\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ semgrep is installed\033[0m\n"
    @if ! command -v codeql >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: codeql is not installed\033[0m\n"; \
        printf "  Install with: brew install codeql\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ codeql is installed\033[0m\n"
    @if ! command -v gitleaks >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: gitleaks is not installed\033[0m\n"; \
        printf "  Install with: brew install gitleaks\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ gitleaks is installed\033[0m\n"
    @if ! command -v shellcheck >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: shellcheck is not installed\033[0m\n"; \
        printf "  Install with: brew install shellcheck\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ shellcheck is installed\033[0m\n"
    @if ! command -v shfmt >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: shfmt is not installed\033[0m\n"; \
        printf "  Install with: brew install shfmt\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ shfmt is installed\033[0m\n"
    @echo ""

help:
    @clear
    @echo ""
    @printf "\033[0;34m=== video-chops-studio ===\033[0m\n"
    @echo ""
    @printf "\033[0;33mSetup & Lifecycle:\033[0m\n"
    @printf "  %-40s %s\n" "init" "Install dependencies"
    @printf "  %-40s %s\n" "destroy" "Remove dependencies and generated artifacts"
    @printf "  %-40s %s\n" "check" "Check prerequisites"
    @printf "  %-40s %s\n" "help" "Show this help message"
    @echo ""
    @printf "\033[0;33mRun & Build:\033[0m\n"
    @printf "  %-40s %s\n" "studio" "Start the editor if it is not running, then open it"
    @printf "  %-40s %s\n" "stop" "Stop the running editor"
    @printf "  %-40s %s\n" "run <args>" "Run the CLI from source (e.g. just run --help)"
    @printf "  %-40s %s\n" "build" "Compile production JavaScript"
    @echo ""
    @printf "\033[0;33mCode Quality:\033[0m\n"
    @printf "  %-40s %s\n" "code-format" "Auto-format code with Prettier"
    @printf "  %-40s %s\n" "code-style" "Check formatting and lint with Prettier + oxlint"
    @printf "  %-40s %s\n" "code-spell" "Check spelling with codespell"
    @printf "  %-40s %s\n" "code-shell" "Check repository shell scripts with shfmt + ShellCheck"
    @printf "  %-40s %s\n" "code-semgrep" "Run custom guardrails with Semgrep"
    @printf "  %-40s %s\n" "code-lspchecks" "Run strict TypeScript checks"
    @printf "  %-40s %s\n" "code-security" "Run the dedicated security lint pass"
    @printf "  %-40s %s\n" "code-secrets" "Scan for committed secrets with Gitleaks"
    @printf "  %-40s %s\n" "code-deptry" "Check dependency and dead-code hygiene with knip"
    @printf "  %-40s %s\n" "code-architecture" "Check import boundaries with dependency-cruiser"
    @printf "  %-40s %s\n" "code-architecture-deep" "Check deep architecture rules with ts-archunit"
    @printf "  %-40s %s\n" "code-package" "Check package structure with publint, attw, and npm pack"
    @printf "  %-40s %s\n" "code-codeql" "Run local CodeQL data-flow analysis"
    @echo ""
    @printf "\033[0;33mCI & Testing:\033[0m\n"
    @printf "  %-40s %s\n" "test" "Run unit, property, type, CLI, and package tests"
    @printf "  %-40s %s\n" "test-coverage" "Run tests with 80%% coverage thresholds"
    @printf "  %-40s %s\n" "test-mutation" "Run StrykerJS with a 80%% mutation score threshold"
    @printf "  %-40s %s\n" "ci" "Run every validation check verbosely"
    @printf "  %-40s %s\n" "ci-quiet" "Run every validation check fail-fast with compact output"
    @echo ""

init: check
    @echo ""
    @printf "\033[34m=== Initializing Development Environment ===\033[0m\n"
    @if ! git rev-parse --git-dir >/dev/null 2>&1; then git init -q; fi
    @npm install
    @printf "\033[32m✓ init completed successfully\033[0m\n"
    @echo ""


run +ARGS:
    @echo ""
    @printf "\033[34m=== Running CLI from Source ===\033[0m\n"
    @npm run --silent cli -- {{ARGS}}
    @printf "\033[32m✓ run completed successfully\033[0m\n"
    @echo ""

STUDIO_URL := "http://127.0.0.1:4310"

studio:
    @echo ""
    @printf "\033[34m=== Starting Video Chops Studio ===\033[0m\n"
    @if curl --silent --fail --max-time 2 "{{STUDIO_URL}}/api/health" >/dev/null; then \
        printf "  Already running at %s\n" "{{STUDIO_URL}}"; \
    else \
        npm run --silent build || exit 1; \
        nohup node dist/index.js studio --input data/input --output data/output --port 4310 >studio.log 2>&1 & \
        sleep 2; \
        if ! curl --silent --fail --max-time 2 "{{STUDIO_URL}}/api/health" >/dev/null; then \
            printf "\033[31m✗ Error: studio did not start, see studio.log\033[0m\n"; \
            echo ""; \
            exit 1; \
        fi; \
    fi
    @open "{{STUDIO_URL}}"
    @printf "\033[32m✓ studio is running at %s\033[0m\n" "{{STUDIO_URL}}"
    @echo ""

stop:
    @echo ""
    @printf "\033[34m=== Stopping Video Chops Studio ===\033[0m\n"
    @if ! curl --silent --fail --max-time 2 "{{STUDIO_URL}}/api/health" >/dev/null; then \
        printf "  Not running\n"; \
    elif ! curl --silent --fail --max-time 5 -X POST "{{STUDIO_URL}}/api/shutdown" >/dev/null; then \
        printf "\033[31m✗ Error: studio rejected the shutdown request\033[0m\n"; \
        echo ""; \
        exit 1; \
    else \
        waiting=""; \
        while curl --silent --fail --max-time 2 "{{STUDIO_URL}}/api/health" >/dev/null; do \
            if [ -z "$waiting" ]; then \
                printf "  Waiting for the active export to finish\n"; \
                waiting=1; \
            fi; \
            sleep 1; \
        done; \
    fi
    @printf "\033[32m✓ studio is stopped\033[0m\n"
    @echo ""


build:
    @echo ""
    @printf "\033[34m=== Building for Production ===\033[0m\n"
    @npm run build
    @printf "\033[32m✓ build completed successfully\033[0m\n"
    @echo ""

destroy:
    @echo ""
    @printf "\033[34m=== Cleaning Generated Artifacts ===\033[0m\n"
    @rm -rf node_modules dist coverage reports .stryker-tmp .codeql-db *.tgz
    @printf "\033[32m✓ destroy completed successfully\033[0m\n"
    @echo ""

code-format:
    @echo ""
    @printf "\033[34m=== Formatting Code ===\033[0m\n"
    @npx prettier --log-level warn --write .
    @printf "\033[32m✓ code-format completed successfully\033[0m\n"
    @echo ""

code-style:
    @echo ""
    @printf "\033[34m=== Checking Code Style ===\033[0m\n"
    @npx prettier --log-level warn --check .
    @npx oxlint --deny-warnings
    @printf "\033[32m✓ code-style completed successfully\033[0m\n"
    @echo ""

code-spell:
    @echo ""
    @printf "\033[34m=== Checking Spelling ===\033[0m\n"
    @codespell src test config scripts arch.rules.ts *.md --ignore-words=config/codespell/ignore.txt
    @printf "\033[32m✓ code-spell completed successfully\033[0m\n"
    @echo ""


code-shell:
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Checking Shell Scripts ===\033[0m\n"
    scripts=()
    while IFS= read -r script; do
        scripts+=("$script")
    done < <(find scripts -type f -name '*.sh' | sort)
    if [ "${#scripts[@]}" -eq 0 ]; then
        printf "  no shell scripts found in scripts/\n"
    else
        shfmt -d "${scripts[@]}"
        shellcheck "${scripts[@]}"
    fi
    printf "\033[32m✓ code-shell completed successfully\033[0m\n"
    echo ""


code-semgrep:
    @echo ""
    @printf "\033[34m=== Running Semgrep Guardrails ===\033[0m\n"
    @semgrep --config config/semgrep/ --error src test scripts
    @printf "\033[32m✓ code-semgrep completed successfully\033[0m\n"
    @echo ""

code-lspchecks:
    @echo ""
    @printf "\033[34m=== Running Type Checks ===\033[0m\n"
    @npx tsc -p tsconfig.json
    @printf "\033[32m✓ code-lspchecks completed successfully\033[0m\n"
    @echo ""

code-security:
    @echo ""
    @printf "\033[34m=== Running Security Lint Pass ===\033[0m\n"
    @npx oxlint --deny-warnings -c config/oxlint/security.oxlintrc.json src
    @printf "\033[32m✓ code-security completed successfully\033[0m\n"
    @echo ""

code-secrets:
    @echo ""
    @printf "\033[34m=== Scanning for Secrets ===\033[0m\n"
    @gitleaks dir . --config .gitleaks.toml --no-banner --redact
    @printf "\033[32m✓ code-secrets completed successfully\033[0m\n"
    @echo ""

code-deptry:
    @echo ""
    @printf "\033[34m=== Checking Dependency and Dead-Code Hygiene ===\033[0m\n"
    @npx knip
    @printf "\033[32m✓ code-deptry completed successfully\033[0m\n"
    @echo ""

code-architecture:
    @echo ""
    @printf "\033[34m=== Checking Import Boundaries ===\033[0m\n"
    @npx depcruise src test --config .dependency-cruiser.cjs
    @printf "\033[32m✓ code-architecture completed successfully\033[0m\n"
    @echo ""

code-architecture-deep:
    @echo ""
    @printf "\033[34m=== Checking Deep Architecture Rules ===\033[0m\n"
    @npx ts-archunit check arch.rules.ts
    @printf "\033[32m✓ code-architecture-deep completed successfully\033[0m\n"
    @echo ""

code-package: build
    @echo ""
    @printf "\033[34m=== Checking Package Correctness ===\033[0m\n"
    @npx publint --strict
    @npx attw --pack . --profile esm-only
    @npm pack --dry-run
    @printf "\033[32m✓ code-package completed successfully\033[0m\n"
    @echo ""

code-codeql:
    @echo ""
    @printf "\033[34m=== Running CodeQL Data-Flow Analysis ===\033[0m\n"
    @rm -rf .codeql-db
    @mkdir -p reports
    @codeql database create .codeql-db --language=javascript-typescript --source-root=. --codescanning-config=config/codeql/config.yml --overwrite --verbosity=warnings
    @codeql database analyze .codeql-db codeql/javascript-queries:codeql-suites/javascript-security-extended.qls --format=sarif-latest --output=reports/codeql.sarif --download --verbosity=warnings
    @node -e 'const sarif = JSON.parse(require("node:fs").readFileSync("reports/codeql.sarif", "utf8")); const results = sarif.runs.flatMap((run) => run.results); for (const result of results) { const location = result.locations?.[0]?.physicalLocation; console.error(`${result.ruleId}: ${result.message.text} (${location?.artifactLocation?.uri}:${location?.region?.startLine})`); } if (results.length > 0) { console.error(`\x1b[31m✗ CodeQL reported ${results.length} finding(s)\x1b[0m`); process.exit(1); }'
    @printf "\033[32m✓ code-codeql completed successfully\033[0m\n"
    @echo ""

test: build
    @echo ""
    @printf "\033[34m=== Running Tests ===\033[0m\n"
    @npm run test
    @printf "\033[32m✓ test completed successfully\033[0m\n"
    @echo ""

test-coverage: build
    @echo ""
    @printf "\033[34m=== Running Tests with Coverage ===\033[0m\n"
    @npm run test:coverage
    @printf "\033[32m✓ test-coverage completed successfully\033[0m\n"
    @echo ""

test-mutation: build
    @echo ""
    @printf "\033[34m=== Running Mutation Tests ===\033[0m\n"
    @npm run test:mutation
    @printf "\033[32m✓ test-mutation completed successfully\033[0m\n"
    @echo ""

ci:
    #!/usr/bin/env bash
    set -e
    echo ""
    printf "\033[34m=== Running CI Checks ===\033[0m\n"
    echo ""
    just check
    just init
    just code-format
    just code-style
    just code-spell
    just code-shell
    just code-semgrep
    just code-lspchecks
    just code-security
    just code-secrets
    just code-deptry
    just code-architecture
    just code-architecture-deep
    just code-package
    just test
    just test-coverage
    just code-codeql
    just test-mutation
    echo ""
    printf "\033[32m✓ ci completed successfully\033[0m\n"
    echo ""

ci-quiet:
    #!/usr/bin/env bash
    set -e
    printf "\033[34m=== Running CI Checks (Quiet Mode) ===\033[0m\n"
    TMPFILE=$(mktemp)
    trap "rm -f $TMPFILE" EXIT

    for target in check init code-format code-style code-spell code-shell code-semgrep \
        code-lspchecks code-security code-secrets code-deptry code-architecture \
        code-architecture-deep code-package test test-coverage code-codeql test-mutation; do
        just "$target" > "$TMPFILE" 2>&1 || { printf "\033[31m✗ %s failed\033[0m\n" "$target"; cat "$TMPFILE"; exit 1; }
        printf "\033[32m✓ %s passed\033[0m\n" "$target"
    done

    echo ""
    printf "\033[32m✓ ci-quiet completed successfully\033[0m\n"
    echo ""
