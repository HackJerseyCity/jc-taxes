import type { Feature, Geometry, Polygon, MultiPolygon } from 'geojson'

export type ParcelProperties = {
  block?: string
  lot?: string
  qual?: string
  addr?: string
  owner?: string
  streets?: string
  year?: number
  paid?: number
  billed?: number
  area_sqft?: number
  unit_sqft?: number
  paid_per_sqft?: number
  billed_per_sqft?: number
  billed_per_capita?: number
  geoid?: string
  ward?: string
  hood?: string       // neighborhood (JC Open Data `jersey-city-neighborhoods`)
  council_person?: string
  population?: number
  paid_per_capita?: number
  stories?: number
  units?: number
  yr_built?: number
  av?: number         // taxable net assessed value, latest MOD-IV (lot / unit views)
  av_x?: number       // exempt / PILOT (class 15*) net assessed value
  bldg_sqft?: number
  bldg_desc?: string
  lots?: Geometry      // tax-lot fragments geometry (ward geometry toggle)
  blocks?: Geometry    // tax-block outlines geometry (ward geometry toggle)
  boundary?: Geometry  // original ward boundary geometry (ward geometry toggle)
}

export type ParcelFeature = Feature<Polygon | MultiPolygon, ParcelProperties>

// What deck.gl hands accessors for a `GeoJsonLayer<ParcelProperties>`: same
// properties, un-narrowed geometry. Accessors that only read `properties`
// should take this so they're usable from both layer types.
export type ParcelFeatureLike = Feature<Geometry, ParcelProperties>
