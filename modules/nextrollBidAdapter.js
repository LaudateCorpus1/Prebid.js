import * as utils from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE } from '../src/mediaTypes.js';

import find from 'core-js-pure/features/array/find.js';

const BIDDER_CODE = 'nextroll';
const BIDDER_ENDPOINT = 'https://d.adroll.com/bid/prebid/';
const ADAPTER_VERSION = 5;

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, NATIVE],

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {BidRequest} bid The bid params to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function (bidRequest) {
    return bidRequest !== undefined && !!bidRequest.params && !!bidRequest.bidId;
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {validBidRequests[]} - an array of bids
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function (validBidRequests, bidderRequest) {
    let topLocation = utils.parseUrl(utils.deepAccess(bidderRequest, 'refererInfo.referer'));
    let consent = hasCCPAConsent(bidderRequest);
    return validBidRequests.map((bidRequest, index) => {
      return {
        method: 'POST',
        options: {
          withCredentials: consent,
        },
        url: BIDDER_ENDPOINT,
        data: {
          id: bidRequest.bidId,
          imp: {
            id: bidRequest.bidId,
            bidfloor: utils.getBidIdParameter('bidfloor', bidRequest.params),
            banner: _getBanner(bidRequest),
            native: _getNative(utils.deepAccess(bidRequest, 'mediaTypes.native')),
            ext: {
              zone: {
                id: utils.getBidIdParameter('zoneId', bidRequest.params)
              },
              nextroll: {
                adapter_version: ADAPTER_VERSION
              }
            }
          },

          user: _getUser(validBidRequests),
          site: _getSite(bidRequest, topLocation),
          seller: _getSeller(bidRequest),
          device: _getDevice(bidRequest),
        }
      }
    })
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {ServerResponse} serverResponse A successful response from the server.
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function (serverResponse, bidRequest) {
    if (!serverResponse.body) {
      return [];
    } else {
      let response = serverResponse.body
      let bids = response.seatbid.reduce((acc, seatbid) => acc.concat(seatbid.bid), []);
      return bids.map((bid) => _buildResponse(response, bid));
    }
  }
}

function _getBanner(bidRequest) {
  let sizes = _getSizes(bidRequest)
  if (sizes === undefined) return undefined
  return {format: sizes}
}

function _getNative(mediaTypeNative) {
  if (mediaTypeNative === undefined) return undefined
  let assets = _getNativeAssets(mediaTypeNative)
  if (assets === undefined || assets.length == 0) return undefined
  return {
    request: {
      native: {
        assets: assets
      }
    }
  }
}

/*
  id: Unique numeric id for the asset
  kind: OpenRTB kind of asset. Supported: title, img and data.
  key: Name of property that comes in the mediaType.native object.
  type: OpenRTB type for that spefic kind of asset.
  required: Overrides the asset required field configured, only overrides when is true.
*/
const NATIVE_ASSET_MAP = [
  {id: 1, kind: 'title', key: 'title', required: true},
  {id: 2, kind: 'img', key: 'image', type: 3, required: true},
  {id: 3, kind: 'img', key: 'icon', type: 1},
  {id: 4, kind: 'img', key: 'logo', type: 2},
  {id: 5, kind: 'data', key: 'sponsoredBy', type: 1},
  {id: 6, kind: 'data', key: 'body', type: 2}
]

const ASSET_KIND_MAP = {
  title: _getTitleAsset,
  img: _getImageAsset,
  data: _getDataAsset,
}

function _getAsset(mediaTypeNative, assetMap) {
  let asset = mediaTypeNative[assetMap.key]
  if (asset === undefined) return undefined
  let assetFunc = ASSET_KIND_MAP[assetMap.kind]
  return {
    id: assetMap.id,
    required: (assetMap.required || !!asset.required) ? 1 : 0,
    [assetMap.kind]: assetFunc(asset, assetMap)
  }
}

function _getTitleAsset(title, _assetMap) {
  return {len: title.len || 0}
}

function _getMinAspectRatio(aspectRatio, property) {
  if (!utils.isPlainObject(aspectRatio)) return 1

  let ratio = aspectRatio['ratio_' + property]
  let min = aspectRatio['min_' + property]

  if (utils.isNumber(ratio)) return ratio
  if (utils.isNumber(min)) return min

  return 1
}

function _getImageAsset(image, assetMap) {
  let sizes = image.sizes
  let aspectRatio = image.aspect_ratios ? image.aspect_ratios[0] : undefined

  return {
    type: assetMap.type,
    w: (sizes ? sizes[0] : undefined),
    h: (sizes ? sizes[1] : undefined),
    wmin: _getMinAspectRatio(aspectRatio, 'width'),
    hmin: _getMinAspectRatio(aspectRatio, 'height'),
  }
}

function _getDataAsset(data, assetMap) {
  return {
    type: assetMap.type,
    len: data.len || 0
  }
}

function _getNativeAssets(mediaTypeNative) {
  return NATIVE_ASSET_MAP.map(assetMap => _getAsset(mediaTypeNative, assetMap)).filter(asset => asset !== undefined)
}

function _getUser(requests) {
  let id = utils.deepAccess(requests, '0.userId.nextroll');
  if (id === undefined) {
    return
  }

  return {
    ext: {
      eid: [{
        'source': 'nextroll',
        id
      }]
    }
  }
}

function _buildResponse(bidResponse, bid) {
  let response = {
    requestId: bidResponse.id,
    cpm: bid.price,
    width: bid.w,
    height: bid.h,
    creativeId: bid.crid,
    dealId: bidResponse.dealId,
    currency: 'USD',
    netRevenue: true,
    meta: {},
    ttl: 300
  }
  if (utils.isStr(bid.adm)) {
    response.meta.mediaType = BANNER
    response.ad = utils.replaceAuctionPrice(bid.adm, bid.price)
  } else {
    response.meta.mediaType = NATIVE
    response.native = _getNativeResponse(bid.adm, bid.price)
  }
  return response
}

function _getNativeResponse(adm, price) {
  let baseResponse = {
    clickUrl: utils.replaceAuctionPrice(adm.link.url, price),
    impressionTrackers: adm.imptrackers.map(impTracker => utils.replaceAuctionPrice(impTracker, price)),
    privacyLink: 'https://info.evidon.com/pub_info/573',
    privacyIcon: 'https://c.betrad.com/pub/icon1.png'
  }
  return adm.assets.reduce((accResponse, asset) => {
    let assetMaps = NATIVE_ASSET_MAP.filter(assetMap => assetMap.id === asset.id && asset[assetMap.kind] !== undefined)
    if (assetMaps.length === 0) return accResponse
    let assetMap = assetMaps[0]
    accResponse[assetMap.key] = _getAssetResponse(asset, assetMap)
    return accResponse
  }, baseResponse)
}

function _getAssetResponse(asset, assetMap) {
  switch (assetMap.kind) {
    case 'title':
      return asset.title.text

    case 'img':
      return {
        url: asset.img.url,
        w: asset.img.w,
        h: asset.img.h
      }

    case 'data':
      return asset.data.value
  }
}

function _getSite(bidRequest, topLocation) {
  return {
    page: topLocation.href,
    domain: topLocation.hostname,
    publisher: {
      id: utils.getBidIdParameter('publisherId', bidRequest.params)
    }
  }
}

function _getSeller(bidRequest) {
  return {
    id: utils.getBidIdParameter('sellerId', bidRequest.params)
  }
}

function _getSizes(bidRequest) {
  if (!utils.isArray(bidRequest.sizes)) {
    return undefined
  }
  return bidRequest.sizes.filter(_isValidSize).map(size => {
    return {
      w: size[0],
      h: size[1]
    }
  })
}

function _isValidSize(size) {
  const isNumber = x => typeof x === 'number';
  return (size.length === 2 && isNumber(size[0]) && isNumber(size[1]));
}

function _getDevice(_bidRequest) {
  return {
    ua: navigator.userAgent,
    language: navigator['language'],
    os: _getOs(navigator.userAgent.toLowerCase()),
    osv: _getOsVersion(navigator.userAgent)
  }
}

function _getOs(userAgent) {
  const osTable = {
    'android': /android/i,
    'ios': /iphone|ipad/i,
    'mac': /mac/i,
    'linux': /linux/i,
    'windows': /windows/i
  };

  return find(Object.keys(osTable), os => {
    if (userAgent.match(osTable[os])) {
      return os;
    }
  }) || 'etc';
}

function _getOsVersion(userAgent) {
  let clientStrings = [
    { s: 'Android', r: /Android/ },
    { s: 'iOS', r: /(iPhone|iPad|iPod)/ },
    { s: 'Mac OS X', r: /Mac OS X/ },
    { s: 'Mac OS', r: /(MacPPC|MacIntel|Mac_PowerPC|Macintosh)/ },
    { s: 'Linux', r: /(Linux|X11)/ },
    { s: 'Windows 10', r: /(Windows 10.0|Windows NT 10.0)/ },
    { s: 'Windows 8.1', r: /(Windows 8.1|Windows NT 6.3)/ },
    { s: 'Windows 8', r: /(Windows 8|Windows NT 6.2)/ },
    { s: 'Windows 7', r: /(Windows 7|Windows NT 6.1)/ },
    { s: 'Windows Vista', r: /Windows NT 6.0/ },
    { s: 'Windows Server 2003', r: /Windows NT 5.2/ },
    { s: 'Windows XP', r: /(Windows NT 5.1|Windows XP)/ },
    { s: 'UNIX', r: /UNIX/ },
    { s: 'Search Bot', r: /(nuhk|Googlebot|Yammybot|Openbot|Slurp|MSNBot|Ask Jeeves\/Teoma|ia_archiver)/ }
  ];
  let cs = find(clientStrings, cs => cs.r.test(userAgent));
  return cs ? cs.s : 'unknown';
}

export function hasCCPAConsent(bidderRequest) {
  if (bidderRequest === undefined) return true;
  if (typeof bidderRequest.uspConsent !== 'string') {
    return true;
  }
  const usps = bidderRequest.uspConsent;
  const version = usps[0];

  // If we don't support the consent string, assume no-consent.
  if (version !== '1' || usps.length < 3) {
    return false;
  }

  const notice = usps[1];
  const optOut = usps[2];

  if (notice === 'N' || optOut === 'Y') {
    return false;
  }
  return true;
}

registerBidder(spec);
