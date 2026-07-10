# Publish FashionRepsSwiper to GitHub (run once after gh auth login)

$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

gh auth status
if ($LASTEXITCODE -ne 0) {
  Write-Host "Run: gh auth login"
  exit 1
}

$owner = (gh api user -q .login)
Write-Host "Publishing as $owner/FashionRepsSwiper"

gh repo create FashionRepsSwiper --public --source=. --remote=origin --push --description "Tinder-style swiper for r/FashionReps trusted seller items"

# Protect main: PRs required, only owner merges (no force push)
gh api repos/$owner/FashionRepsSwiper/branches/main/protection -X PUT -f required_pull_request_reviews[required_approving_review_count]=0 -f enforce_admins=false -f required_status_checks=null -F restrictions=null -f allow_force_pushes=false -f allow_deletions=false

Write-Host "Done: https://github.com/$owner/FashionRepsSwiper"
Write-Host "Branch protection enabled on main. Contributors must use pull requests."
