/*
 * The customer's probable time zone from their phone number, so the quiet-hour window follows the customer rather
 * than the contact centre. Country calling code first; for North American numbers (+1) the area code decides.
 * Unknown numbers return null and the caller falls back to the stack's zone. Pure.
 *
 * The area-code table covers the zones that matter for a send window (Eastern, Central, Mountain, Pacific,
 * Alaska, Hawaii, Atlantic, Newfoundland); a code missing from it falls back to the stack zone, never to a guess.
 */
'use strict';

const NANP = {
  'America/New_York': '201 202 203 207 212 215 216 220 223 224 229 231 234 239 240 248 267 269 272 276 301 302 304 305 313 315 316 317 319 321 325 326 330 331 332 336 339 341 343 345 347 351 352 363 364 380 386 401 404 407 410 412 413 419 423 434 440 443 445 464 470 475 478 484 502 513 516 517 518 540 551 561 567 570 571 585 586 603 606 607 609 610 614 616 617 631 646 647 656 657 660 667 678 680 681 684 686 689 703 704 706 717 718 724 727 732 734 740 743 747 754 757 762 770 772 774 781 786 802 803 804 810 813 814 828 843 845 848 854 856 857 859 860 862 863 864 865 878 904 906 908 910 912 913 914 917 919 920 929 931 934 937 938 941 947 954 959 970 973 980 984 989 416 437 613 647 705 416 519 226 289 365 905 343 548 742 873 819 438 514 450 579 581 418 367 263',
  'America/Chicago': '205 210 214 217 218 224 225 228 251 254 256 262 270 281 309 312 314 318 319 320 331 334 337 346 361 364 402 405 409 414 417 430 432 456 469 479 501 504 507 512 515 531 534 539 563 573 580 601 605 608 612 615 618 630 636 651 660 662 682 701 708 712 713 715 726 731 737 763 769 773 779 785 806 812 815 816 817 830 832 847 850 854 856 870 872 901 903 913 918 920 936 940 945 952 956 972 979 985 204 431 306 639',
  'America/Denver': '208 303 307 385 406 435 505 520 575 602 623 719 720 801 928 970 982 983 403 587 780 825',
  'America/Phoenix': '480 520 602 623 928',
  'America/Los_Angeles': '206 209 213 253 279 310 323 341 360 408 415 424 442 458 503 509 510 530 559 562 564 619 626 628 650 657 661 669 702 707 714 725 747 760 775 805 818 820 831 840 858 909 916 925 949 951 971 604 778 236 672 250',
  'America/Anchorage': '907',
  'Pacific/Honolulu': '808',
  'America/Halifax': '902 782 506',
  'America/St_Johns': '709',
  'America/Puerto_Rico': '787 939 340',
};
const AREA = {};
for (const [zone, codes] of Object.entries(NANP)) for (const c of codes.split(/\s+/)) AREA[c] = AREA[c] || zone;

/** Single-zone countries by calling code (longest code first when matching). Multi-zone countries are left to the fallback. */
const COUNTRY = { '44': 'Europe/London', '353': 'Europe/Dublin', '33': 'Europe/Paris', '49': 'Europe/Berlin', '34': 'Europe/Madrid', '39': 'Europe/Rome', '31': 'Europe/Amsterdam', '32': 'Europe/Brussels', '41': 'Europe/Zurich', '43': 'Europe/Vienna', '45': 'Europe/Copenhagen', '46': 'Europe/Stockholm', '47': 'Europe/Oslo', '358': 'Europe/Helsinki', '48': 'Europe/Warsaw', '420': 'Europe/Prague', '36': 'Europe/Budapest', '351': 'Europe/Lisbon', '30': 'Europe/Athens', '40': 'Europe/Bucharest', '90': 'Europe/Istanbul', '972': 'Asia/Jerusalem', '971': 'Asia/Dubai', '966': 'Asia/Riyadh', '91': 'Asia/Kolkata', '65': 'Asia/Singapore', '60': 'Asia/Kuala_Lumpur', '66': 'Asia/Bangkok', '63': 'Asia/Manila', '81': 'Asia/Tokyo', '82': 'Asia/Seoul', '852': 'Asia/Hong_Kong', '886': 'Asia/Taipei', '64': 'Pacific/Auckland', '27': 'Africa/Johannesburg', '234': 'Africa/Lagos', '254': 'Africa/Nairobi', '20': 'Africa/Cairo', '52': 'America/Mexico_City', '57': 'America/Bogota', '51': 'America/Lima', '56': 'America/Santiago', '54': 'America/Argentina/Buenos_Aires', '598': 'America/Montevideo', '506': 'America/Costa_Rica', '507': 'America/Panama', '593': 'America/Guayaquil', '58': 'America/Caracas', '1876': 'America/Jamaica' };

function zoneOf(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits[0] === '1') return AREA[digits.slice(1, 4)] || null;
  for (const len of [4, 3, 2]) { const z = COUNTRY[digits.slice(0, len)]; if (z) return z; }
  return null;
}

module.exports = { zoneOf, AREA, COUNTRY };
