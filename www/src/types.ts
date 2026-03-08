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
  geoid?: string
  ward?: string
  council_person?: string
  population?: number
  paid_per_capita?: number
  stories?: number
  units?: number
  yr_built?: number
  bldg_sqft?: number
  bldg_desc?: string
  lots?: Geometry      // tax-lot fragments geometry (ward geometry toggle)
  blocks?: Geometry    // tax-block outlines geometry (ward geometry toggle)
  boundary?: Geometry  // original ward boundary geometry (ward geometry toggle)
}

export type ParcelFeature = Feature<Polygon | MultiPolygon, ParcelProperties>
