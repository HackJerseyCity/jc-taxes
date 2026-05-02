"""HLS Property Tax API client with rate limiting and caching."""
import gzip
import json
import random
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterator, Optional, Union

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from .models import AccountInquiry, AccountResponse
from .paths import CACHE

BASE_URL = "https://apps.hlssystems.com/JerseyCity/PropertyTaxInquiry"


def parse_ttl(ttl: Union[str, int, float, timedelta, None]) -> Optional[timedelta]:
    """
    Parse TTL value into timedelta.

    Accepts:
        - None: no TTL (use cache forever)
        - int/float: seconds
        - str: e.g. "1h", "2d", "30m", "1w"
        - timedelta: pass through
    """
    if ttl is None:
        return None
    if isinstance(ttl, timedelta):
        return ttl
    if isinstance(ttl, (int, float)):
        return timedelta(seconds=ttl)
    if isinstance(ttl, str):
        units = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800}
        if ttl[-1] in units:
            return timedelta(seconds=float(ttl[:-1]) * units[ttl[-1]])
        return timedelta(seconds=float(ttl))
    raise ValueError(f"Invalid TTL: {ttl}")


class RateLimiter:
    """Simple rate limiter with jitter."""

    def __init__(self, min_delay: float = 0.5, max_delay: float = 1.5):
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.last_request: float = 0

    def wait(self):
        """Wait before next request with random jitter."""
        elapsed = time.time() - self.last_request
        delay = random.uniform(self.min_delay, self.max_delay)
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self.last_request = time.time()


class HLSClient:
    """Client for Jersey City HLS Property Tax API."""

    def __init__(
        self,
        cache_dir: Optional[Path] = None,
        rate_limit: bool = True,
        min_delay: float = 0.5,
        max_delay: float = 1.5,
    ):
        self.cache_dir = Path(cache_dir) if cache_dir else CACHE
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.client = httpx.Client(timeout=30.0)
        self.rate_limiter = RateLimiter(min_delay, max_delay) if rate_limit else None

    def _format_date(self, d: Optional[date] = None) -> str:
        """Format date as JS toDateString() output: 'Sat Jan 31 2026'."""
        if d is None:
            d = date.today()
        return d.strftime("%a %b %d %Y")

    def _cache_path(self, account: int | str) -> Path:
        """Get cache path for an account (.json.gz preferred, falls back to .json)."""
        gz_path = self.cache_dir / f"{account}.json.gz"
        if gz_path.exists():
            return gz_path
        json_path = self.cache_dir / f"{account}.json"
        if json_path.exists():
            return json_path
        return gz_path  # default to .gz for new files

    def _load_cache(self, account: int | str, ttl: Optional[timedelta] = None) -> Optional[dict]:
        """Load cached response if exists and not expired."""
        path = self._cache_path(account)
        if not path.exists():
            return None

        # Check TTL if specified
        if ttl is not None:
            mtime = datetime.fromtimestamp(path.stat().st_mtime)
            if datetime.now() - mtime > ttl:
                return None  # Cache expired

        if path.suffix == '.gz':
            with gzip.open(path, 'rt') as f:
                return json.load(f)
        with open(path) as f:
            return json.load(f)

    def _save_cache(self, account: int | str, data: dict):
        """Save response to cache as .json.gz."""
        path = self.cache_dir / f"{account}.json.gz"
        with gzip.open(path, 'wt') as f:
            json.dump(data, f, indent=2)
        # Remove old .json if it exists
        json_path = self.cache_dir / f"{account}.json"
        if json_path.exists():
            json_path.unlink()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    def _get(self, url: str) -> dict:
        """Make GET request with retry logic."""
        if self.rate_limiter:
            self.rate_limiter.wait()
        resp = self.client.get(url)
        resp.raise_for_status()
        return resp.json()

    def get_account_details(
        self,
        account: int | str,
        interest_date: Optional[date] = None,
        use_cache: bool = True,
        ttl: Union[str, int, float, timedelta, None] = None,
    ) -> Optional[AccountResponse]:
        """
        Fetch full account details by account number or B-L-Q.

        Args:
            account: Account number (665435) or B-L-Q string (9806-8-C0608)
            interest_date: Date for interest calculation (default: today)
            use_cache: Whether to use/update local cache
            ttl: Cache TTL - None=forever, or "1h", "2d", 3600, etc.

        Returns:
            AccountResponse or None if invalid account
        """
        ttl_delta = parse_ttl(ttl)
        if use_cache:
            cached = self._load_cache(account, ttl=ttl_delta)
            if cached:
                return AccountResponse.model_validate(cached)

        date_str = self._format_date(interest_date)
        url = f"{BASE_URL}/GetAccountDetails?accountNumber={account}&interestThruDate={date_str}"

        try:
            data = self._get(url)
        except httpx.HTTPStatusError:
            return None

        if not data.get("validAccountNumber", False):
            return None

        if use_cache:
            self._save_cache(account, data)

        return AccountResponse.model_validate(data)

    def search_accounts(
        self,
        search_type: str,
        search_field: str,
        page: int = 1,
    ) -> tuple[list[dict], int]:
        """
        Search for accounts.

        Args:
            search_type: One of "Account", "BLQ", "OwnerName", "PropertyLocation"
            search_field: Search term
            page: Page number (1-indexed)

        Returns:
            Tuple of (accounts list, total count)
        """
        url = f"{BASE_URL}/GetAccounts?page={page}&searchType={search_type}&searchField={search_field}"
        data = self._get(url)
        return data.get("accounts", []), data.get("recCount", 0)

    def search_by_block(self, block: str) -> Iterator[dict]:
        """
        Iterate all accounts in a block.

        Yields account summaries (AccountNumber, Block, Lot, Qualifier, etc.)
        """
        page = 1
        while True:
            accounts, total = self.search_accounts("BLQ", block, page)
            if not accounts:
                break
            yield from accounts
            if page * 10 >= total:  # 10 results per page
                break
            page += 1

    def iter_all_accounts(self, blocks: list[str]) -> Iterator[dict]:
        """
        Iterate all accounts across multiple blocks.

        Args:
            blocks: List of block numbers to search

        Yields:
            Account summary dicts from search results
        """
        for block in blocks:
            yield from self.search_by_block(block)

    def close(self):
        """Close HTTP client."""
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
