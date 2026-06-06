"""Pydantic models for HLS API responses."""
from datetime import date, datetime
from pydantic import BaseModel, Field, field_validator
from typing import Optional


class Detail(BaseModel):
    """Transaction-level record (bill, payment, adjustment)."""
    TaxYear: int
    Quarter: int
    BillNumber: int = 0
    TransactionDate: str
    Description: str
    Type: int
    Billed: float = 0.0
    Paid: float = 0.0
    Adjusted: float = 0.0
    Balance: float = 0.0
    Interest: float = 0.0
    Days: int = 0
    PaymentSourceDescription: str = ""
    TransactionId: int = 0
    TransCode: int = 0

    @field_validator("TransactionDate", mode="before")
    @classmethod
    def parse_date(cls, v):
        if v is None:
            return ""
        return str(v).strip()


class YearlySummary(BaseModel):
    """Annual summary of taxes."""
    Year: int
    Land: float = 0.0
    Improvement: float = 0.0
    Exemption: float = 0.0
    NetTaxable: float = 0.0
    Deduction: float = 0.0
    Billed: float = 0.0
    BillingAdjusted: float = 0.0
    NetBilled: float = 0.0
    Paid: float = 0.0
    PaymentAdjusted: float = 0.0
    NetPaid: float = 0.0
    OpenBalance: float = 0.0


class QuarterlySummary(BaseModel):
    """Quarterly summary of taxes."""
    Year: int
    Quarter: int
    Billed: float = 0.0
    BillingAdjusted: float = 0.0
    NetBilled: float = 0.0
    Paid: float = 0.0
    PaymentAdjusted: float = 0.0
    NetPaid: float = 0.0
    OpenBalance: float = 0.0


class Lien(BaseModel):
    """Tax lien record."""
    CertificateNumber: str = ""
    TaxYear: int = 0
    Type: str = ""
    TaxsaleDate: str = ""
    CertificateAmount: float = 0.0
    SubsequentCharges: float = 0.0
    OpenBalance: float = 0.0
    LienHolderName: str = ""
    Status: str = ""


class AccountInquiry(BaseModel):
    """Main property account data."""
    # Identifiers
    AccountId: int = 0
    AccountNumber: int
    Block: str
    Lot: str
    Qualifier: str = ""

    # Location
    PropertyLocation: str = ""
    Address: str = ""
    CityState: str = ""
    PostalCode: str = ""

    # Owner
    OwnerName: str = ""

    # Assessments
    Land: float = 0.0
    Improvement: float = 0.0
    NetTaxable: float = 0.0
    Class: str = ""

    # Property description
    BuildingDescription: str = ""
    LandDescription: str = ""
    AdditionalLots: str = ""
    Zoning: Optional[str] = None
    TaxMapPage: str = ""
    FireDistrict: int = 0

    # Deed info
    DeedBook: str = ""
    DeedPage: str = ""
    DeedDate: int = 0  # Stored as int (MMDDYY or similar)
    SalePrice: float = 0.0
    SaleAssessment: float = 0.0

    # Exemptions
    Seniors: int = 0
    Veterans: int = 0
    Disabled: int = 0
    SurvivingSpouse: int = 0
    Widow: int = 0
    ExemptCode1: Optional[str] = None
    ExemptAmount1: float = 0.0
    ExemptCode2: Optional[str] = None
    ExemptAmount2: float = 0.0
    ExemptCode3: Optional[str] = None
    ExemptAmount3: float = 0.0
    ExemptCode4: Optional[str] = None
    ExemptAmount4: float = 0.0

    # Current balance
    Principal: float = 0.0
    Interest: float = 0.0
    TotalDue: float = 0.0
    Deduction: float = 0.0
    BankName: str = ""

    # Status flags
    DelinquentStatus: bool = False
    PendingTaxsale: bool = False
    OpenTownLien: bool = False
    LienCount: int = 0

    # Related records
    Details: Optional[list[Detail]] = Field(default_factory=list)
    YearlySummaries: Optional[list[YearlySummary]] = Field(default_factory=list)
    QuarterlySummaries: Optional[list[QuarterlySummary]] = Field(default_factory=list)
    AccountLiens: Optional[list[Lien]] = Field(default_factory=list)

    @field_validator("Details", "YearlySummaries", "QuarterlySummaries", "AccountLiens", mode="before")
    @classmethod
    def empty_list_if_none(cls, v):
        return v if v is not None else []

    @field_validator(
        "Block", "Lot", "Qualifier",
        "PropertyLocation", "Address", "CityState", "PostalCode", "OwnerName",
        "BuildingDescription", "LandDescription", "AdditionalLots",
        "TaxMapPage", "DeedBook", "DeedPage",
        "Class", "BankName",
        mode="before",
    )
    @classmethod
    def strip_strings(cls, v):
        if v is None:
            return ""
        return str(v).strip()

    @field_validator("DeedDate", "FireDistrict", "AccountId", "LienCount", mode="before")
    @classmethod
    def zero_if_none(cls, v):
        return 0 if v is None else v

    @property
    def blq(self) -> str:
        """Block-Lot-Qualifier string."""
        q = self.Qualifier or ""
        return f"{self.Block}-{self.Lot}-{q}".rstrip("-")


class AccountResponse(BaseModel):
    """Full API response for GetAccountDetails."""
    accountInquiryVM: AccountInquiry
    validAccountNumber: bool = True

    @property
    def account(self) -> AccountInquiry:
        return self.accountInquiryVM
