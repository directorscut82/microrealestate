import { Marker, Map as PigeonMap } from 'pigeon-maps';
import { useEffect, useState } from 'react';
import axios from 'axios';
import Loading from './Loading';
import { LocationIllustration } from './Illustrations';

const nominatimBaseURL = 'https://nominatim.openstreetmap.org';

function cleanStreetForGeocoding(street) {
  if (!street) return '';
  return street.replace(/,\s*Όροφος\s*-?\d+/i, '').trim();
}

export default function Map({ address }) {
  const [center, setCenter] = useState();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getLatLong = async () => {
      setLoading(true);

      if (address) {
        let queryParams;
        if (typeof address === 'object') {
          const street = cleanStreetForGeocoding(address.street1);
          queryParams = new URLSearchParams({
            street,
            city: address.city || '',
            postalcode: address.zipCode || '',
            country: address.country || '',
            format: 'json',
            addressdetails: '1'
          }).toString();
        } else {
          queryParams = `q=${encodeURIComponent(address)}&format=json&addressdetails=1`;
        }

        try {
          const response = await axios.get(
            `${nominatimBaseURL}/search?${queryParams}`
          );

          if (response.data?.[0]?.lat && response.data?.[0]?.lon) {
            setCenter([
              Number(response.data[0].lat),
              Number(response.data[0].lon)
            ]);
          } else {
            setCenter();
          }
        } catch (error) {
          console.error(error);
        }
      }

      setLoading(false);
    };

    getLatLong();
  }, [address]);

  return (
    <div className={`flex items-center justify-center w-full h-64`}>
      {!loading ? (
        center ? (
          <PigeonMap height={256} center={center} zoom={16}>
            <Marker
              height={35}
              width={35}
              color="#2563eb"
              anchor={center}
            />
          </PigeonMap>
        ) : (
          <LocationIllustration />
        )
      ) : (
        <Loading fullScreen={false} />
      )}
    </div>
  );
}
