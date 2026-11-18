[CmdletBinding()]
param([string]$Archive)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = Split-Path -Parent $PSScriptRoot
$integration = Join-Path $root 'integration/magpie'
$stage = Join-Path $root 'src-tauri/magpie-stage'
$work = Join-Path ([IO.Path]::GetTempPath()) ("buddyrelay-magpie-build-" + [guid]::NewGuid())
$version = 'v0.1.4456'
$revision = '54117164cd593493bfafcc0dc4ac8bae95798b88'
$digest = 'AD0CD2E15A5DF4936175DE832D2394F915DA925FA820DCD787C340615AF97B3E'
$source = Join-Path $work "magpie-$revision"
$nl = [string][char]10
$tab = [string][char]9

function Insert-Source([string]$Path, [string]$Anchor, [string]$Replacement) {
    $path = Join-Path $source $Path
    $contents = [IO.File]::ReadAllText($path)
    $index = $contents.IndexOf($Anchor, [StringComparison]::Ordinal)
    if ($index -lt 0 -or $contents.LastIndexOf($Anchor, [StringComparison]::Ordinal) -ne $index) {
        throw "Magpie source has changed at $Path"
    }
    [IO.File]::WriteAllText($path, $contents.Remove($index, $Anchor.Length).Insert($index, $Replacement))
}

New-Item -ItemType Directory -Path $work | Out-Null
if (!$Archive) {
    $Archive = Join-Path $work 'source.zip'
    curl.exe --fail --silent --show-error --location --retry 3 "https://codeload.github.com/yetone/magpie/zip/$revision" --output $Archive
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash -ne $digest) {
    throw 'Magpie source archive failed SHA-256 verification'
}
Expand-Archive -LiteralPath $Archive -DestinationPath $work

Copy-Item -LiteralPath "$integration/buddyrelay.go", "$integration/buddyrelay_test.go" -Destination "$source/internal/gui"
Copy-Item -LiteralPath "$integration/buddyrelay.js", "$integration/buddyrelay.css" -Destination "$source/internal/gui/assets"

Insert-Source 'internal/gui/api.go' 'devRoutes(mux)' "devRoutes(mux)${nl}${tab}buddyRelayRoutes(mux)"
$style = '<link rel="stylesheet" href="buddyrelay.css">'
Insert-Source 'internal/gui/assets/index.html' '</head>' "$style$nl</head>"
$button = '<button type="button" class="icon" id="buddyrelayOpen" hidden>WorkBuddy</button>'
$update = '<span class="update-wrap">'
Insert-Source 'internal/gui/assets/index.html' $update "$button$nl    $update"
$dialog = [IO.File]::ReadAllText("$integration/dialog.html").Trim()
$script = '<script src="buddyrelay.js"></script>'
$start = '<script src="start.js"></script>'
Insert-Source 'internal/gui/assets/index.html' $start "$dialog$nl$script$nl$start"

# Use Magpie's package-manager update path for the bundled binary.
$manager = @'
	if p.Manager == "BuddyRelay" {
		return "https://github.com/loveApril1006/buddyrelay-desktop/releases/latest"
	}
'@
$commandAnchor = 'func (p *Packaged) Command() string {'
Insert-Source 'internal/update/packaged.go' $commandAnchor "$commandAnchor$nl$manager$nl"
$packaged = @'
	dir := filepath.Dir(exe)
	if runtime.GOOS == "windows" && strings.EqualFold(filepath.Base(dir), "magpie") {
		if st, err := os.Stat(filepath.Join(filepath.Dir(dir), "buddyrelay.exe")); err == nil && st.Mode().IsRegular() {
			return &Packaged{Manager: "BuddyRelay"}
		}
	}
'@
$packageAnchor = 'func PackagedBy(exe string) *Packaged {'
Insert-Source 'internal/update/packaged.go' $packageAnchor "$packageAnchor$nl$packaged$nl"

New-Item -ItemType Directory -Path $stage -Force | Out-Null
Push-Location -LiteralPath $source
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    gofmt -w internal/gui/buddyrelay.go internal/gui/buddyrelay_test.go internal/update/packaged.go
    go test ./internal/gui -run '^TestBuddyRelay' -count=1
    go run ./build/assetpack internal/gui/assets internal/gui/assets.zip
    go run ./build/conpty
    go run github.com/tc-hib/go-winres@v0.3.3 make --in build/windows/winres.json --arch amd64 --out rsrc --file-version $version.Substring(1) --product-version $version.Substring(1)
    go build -trimpath -buildvcs=false -ldflags '-s -w' -o internal/update/launcher-amd64.com ./internal/update/launcher
    go build -mod=readonly -buildvcs=false -trimpath -tags 'production,comlauncher,packedassets,conptypair' -ldflags "-s -w -X main.version=$version -H windowsgui" -o "$stage/magpie.exe" .
    Copy-Item -LiteralPath LICENSE -Destination "$stage/LICENSE"
    Copy-Item -LiteralPath THIRD_PARTY_NOTICES -Destination "$stage/THIRD_PARTY_NOTICES"
} finally {
    Pop-Location
}
